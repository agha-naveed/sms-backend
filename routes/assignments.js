const express = require("express");
const { query, queryOne } = require("../db");
const {
  requireLogin,
  allow,
  getStudentOfUser,
  getTeacherOfUser,
  teacherOwnsSection,
  teacherOwnsSubject,
  parentOwnsStudent,
} = require("../auth");
const { upload, notify, logAudit } = require("../helpers");

const router = express.Router();
router.use(requireLogin);

// How long an assignment stays visible to students and parents after its due
// date. Nothing is deleted: the teacher keeps seeing it with the submissions,
// and every uploaded file stays on disk.
const VISIBLE_DAYS_AFTER_DUE = Number(process.env.ASSIGNMENT_VISIBLE_DAYS || 2);

// ------------------------------------------------------------------
// GET /api/assignments
// What comes back depends on who is asking:
//   teacher  -> assignments they posted
//   student  -> assignments for their own class + section, with their submission
//   parent   -> pass ?student_id=, gets that child's assignments
//   admin    -> everything
// ------------------------------------------------------------------
router.get("/", async function (req, res) {
  try {
    const role = req.user.role;
    let classId = null;
    let sectionId = null;
    let studentId = null;

    if (role === "student") {
      const me = await getStudentOfUser(req.user.id);
      if (!me) return res.json([]);
      classId = me.class_id;
      sectionId = me.section_id;
      studentId = me.id;
    }

    if (role === "parent") {
      studentId = Number(req.query.student_id);
      if (!studentId) return res.status(400).json({ message: "Choose a child first." });

      const ok = await parentOwnsStudent(req.user.id, studentId);
      if (!ok) return res.status(403).json({ message: "That is not your child." });

      const child = await queryOne("SELECT class_id, section_id FROM students WHERE id = $1", [
        studentId,
      ]);
      classId = child.class_id;
      sectionId = child.section_id;
    }

    if (role === "teacher") {
      const teacher = await getTeacherOfUser(req.user.id);
      if (!teacher) return res.json([]);

      return res.json(
        await query(
          `SELECT a.*, c.name AS class_name, sec.name AS section_name, sub.name AS subject_name,
                  (SELECT COUNT(*)::int FROM submissions sm WHERE sm.assignment_id = a.id) AS submission_count,
                  (SELECT COUNT(*)::int FROM students s
                    WHERE s.class_id = a.class_id AND s.section_id = a.section_id
                      AND s.status = 'active') AS student_count
             FROM assignments a
             JOIN classes c    ON c.id = a.class_id
             JOIN sections sec ON sec.id = a.section_id
             LEFT JOIN subjects sub ON sub.id = a.subject_id
            WHERE a.teacher_id = $1
            ORDER BY a.created_at DESC`,
          [teacher.id]
        )
      );
    }

    // admin: optional filters
    if (role === "admin") {
      classId = req.query.class_id || null;
      sectionId = req.query.section_id || null;
    }

    const rows = await query(
      `SELECT a.*, c.name AS class_name, sec.name AS section_name, sub.name AS subject_name,
              tu.full_name AS teacher_name,
              sm.id AS submission_id, sm.file AS submission_file, sm.submitted_at, sm.note AS submission_note
         FROM assignments a
         JOIN classes c    ON c.id = a.class_id
         JOIN sections sec ON sec.id = a.section_id
         LEFT JOIN subjects sub ON sub.id = a.subject_id
         LEFT JOIN teachers t   ON t.id = a.teacher_id
         LEFT JOIN users tu     ON tu.id = t.user_id
         LEFT JOIN submissions sm ON sm.assignment_id = a.id AND sm.student_id = $3
        WHERE ($1::int IS NULL OR a.class_id = $1)
          AND ($2::int IS NULL OR a.section_id = $2)
          -- An assignment disappears from the student and parent list a few
          -- days after its due date. Teachers keep seeing it, with the work
          -- that was handed in.
          AND ($4::boolean = FALSE
               OR a.due_date IS NULL
               OR a.due_date >= CURRENT_DATE - ($5 || ' days')::INTERVAL)
        ORDER BY a.due_date DESC NULLS LAST, a.created_at DESC`,
      [
        classId,
        sectionId,
        studentId,
        role === "student" || role === "parent",
        String(VISIBLE_DAYS_AFTER_DUE),
      ]
    );

    // Tell the browser whether the upload box should still be open.
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const withStatus = rows.map(function (a) {
      const closed = a.due_date ? new Date(a.due_date) < today : false;

      // How many days are left before it drops off the student's list.
      let daysLeft = null;
      if (closed && a.due_date) {
        const gone = new Date(a.due_date);
        gone.setDate(gone.getDate() + VISIBLE_DAYS_AFTER_DUE);
        daysLeft = Math.max(0, Math.ceil((gone - today) / (24 * 60 * 60 * 1000)));
      }

      return { ...a, upload_closed: closed, days_until_hidden: daysLeft };
    });

    res.json(withStatus);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load assignments." });
  }
});

// ------------------------------------------------------------------
// POST /api/assignments   (teacher)
// Optional file from the teacher, e.g. a question paper.
// ------------------------------------------------------------------
router.post("/", allow("teacher", "admin"), upload.single("file"), async function (req, res) {
  try {
    const b = req.body;

    if (!b.title || !b.class_id || !b.section_id) {
      return res.status(400).json({ message: "Title, class and section are required." });
    }

    let teacherId = null;

    if (req.user.role === "teacher") {
      // Checking the subject as well as the section, so a maths teacher
      // cannot post an assignment under somebody else's subject.
      const ok = b.subject_id
        ? await teacherOwnsSubject(req.user.id, b.class_id, b.section_id, b.subject_id)
        : await teacherOwnsSection(req.user.id, b.class_id, b.section_id);

      if (!ok) {
        return res.status(403).json({
          message: b.subject_id
            ? "You do not teach that subject in this section."
            : "You are not assigned to this section.",
        });
      }

      const teacher = await getTeacherOfUser(req.user.id);
      teacherId = teacher.id;
    }

    const rows = await query(
      `INSERT INTO assignments
         (teacher_id, class_id, section_id, subject_id, title, description, file, due_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        teacherId,
        b.class_id,
        b.section_id,
        b.subject_id || null,
        b.title,
        b.description || null,
        req.file ? req.file.filename : null,
        b.due_date || null,
      ]
    );

    // Tell the students in that section, and their parents.
    const people = await query(
      `SELECT u.id AS student_user_id, pu.id AS parent_user_id, u.full_name AS student_name
         FROM students s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN parents p ON p.id = s.parent_id
         LEFT JOIN users pu  ON pu.id = p.user_id
        WHERE s.class_id = $1 AND s.section_id = $2 AND s.status = 'active'`,
      [b.class_id, b.section_id]
    );

    const due = b.due_date ? " Due " + new Date(b.due_date).toDateString() + "." : "";

    for (const person of people) {
      await notify(person.student_user_id, "New assignment: " + b.title, (b.description || "") + due, "assignment");
      await notify(
        person.parent_user_id,
        "New assignment for " + person.student_name,
        b.title + "." + due,
        "assignment"
      );
    }

    res.status(201).json(rows[0]);

    logAudit(req.user, "posted", "assignment", b.title, people.length + " students and their parents notified");
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not post the assignment." });
  }
});

// ------------------------------------------------------------------
// POST /api/assignments/:id/submit   (student uploads their work)
// ------------------------------------------------------------------
router.post("/:id/submit", allow("student"), upload.single("file"), async function (req, res) {
  try {
    if (!req.file) return res.status(400).json({ message: "Choose a file to upload." });

    const me = await getStudentOfUser(req.user.id);
    if (!me) return res.status(404).json({ message: "Student record not found." });

    const assignment = await queryOne("SELECT * FROM assignments WHERE id = $1", [req.params.id]);
    if (!assignment) return res.status(404).json({ message: "Assignment not found." });

    // A student can only submit to their own class + section.
    if (assignment.class_id !== me.class_id || assignment.section_id !== me.section_id) {
      return res.status(403).json({ message: "This assignment is not for your class." });
    }

    // Uploading closes at the end of the due date.
    if (assignment.due_date) {
      const due = new Date(assignment.due_date);
      const today = new Date();
      due.setHours(23, 59, 59, 999);
      if (today > due) {
        return res.status(400).json({
          message: "The due date has passed, so this assignment can no longer be uploaded.",
        });
      }
    }

    // Re-uploading replaces the earlier file.
    const rows = await query(
      `INSERT INTO submissions (assignment_id, student_id, file, note)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (assignment_id, student_id)
       DO UPDATE SET file = EXCLUDED.file, note = EXCLUDED.note, submitted_at = NOW()
       RETURNING *`,
      [assignment.id, me.id, req.file.filename, req.body.note || null]
    );

    res.status(201).json({ message: "Work uploaded.", submission: rows[0] });

    logAudit(req.user, "submitted", "assignment_work", assignment.title, "File uploaded");
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not upload your work." });
  }
});

// ------------------------------------------------------------------
// GET /api/assignments/:id/submissions  (teacher checks who handed in)
// ------------------------------------------------------------------
router.get("/:id/submissions", allow("teacher", "admin"), async function (req, res) {
  try {
    // A teacher sees the work handed in for their own assignments only.
    if (req.user.role === "teacher") {
      const teacher = await getTeacherOfUser(req.user.id);
      const own = await queryOne(
        "SELECT id FROM assignments WHERE id = $1 AND teacher_id = $2",
        [req.params.id, teacher ? teacher.id : null]
      );
      if (!own) {
        return res.status(403).json({
          message: "That assignment was posted by somebody else.",
        });
      }
    }

    const rows = await query(
      `SELECT s.id AS student_id, u.full_name AS name,
              sm.file, sm.note, sm.submitted_at
         FROM students s
         JOIN users u ON u.id = s.user_id
         JOIN assignments a ON a.id = $1
         LEFT JOIN submissions sm ON sm.assignment_id = a.id AND sm.student_id = s.id
        WHERE s.class_id = a.class_id AND s.section_id = a.section_id AND s.status = 'active'
        ORDER BY u.full_name`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load submissions." });
  }
});

// DELETE /api/assignments/:id
router.delete("/:id", allow("teacher", "admin"), async function (req, res) {
  try {
    if (req.user.role === "teacher") {
      const teacher = await getTeacherOfUser(req.user.id);
      const own = await queryOne("SELECT id FROM assignments WHERE id = $1 AND teacher_id = $2", [
        req.params.id,
        teacher.id,
      ]);
      if (!own) return res.status(403).json({ message: "You can only delete your own assignments." });
    }

    const gone = await queryOne("SELECT title FROM assignments WHERE id = $1", [req.params.id]);
    await query("DELETE FROM assignments WHERE id = $1", [req.params.id]);
    res.json({ message: "Assignment deleted." });

    if (gone) logAudit(req.user, "deleted", "assignment", gone.title);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not delete the assignment." });
  }
});

module.exports = router;
