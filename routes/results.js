const express = require("express");
const { query, queryOne } = require("../db");
const {
  requireLogin,
  allow,
  getStudentOfUser,
  getTeacherOfUser,
  parentOwnsStudent,
  teacherOwnsSection,
  teacherOwnsSubject,
} = require("../auth");
const { notify, logAudit } = require("../helpers");
const { EXAMS, isRealExam } = require("../exams");

const router = express.Router();
router.use(requireLogin);

const PASS_MARK = 40; // percent

// Turns a percentage into a grade. Change these to match your school.
function grade(percent) {
  if (percent >= 80) return "A+";
  if (percent >= 70) return "A";
  if (percent >= 60) return "B";
  if (percent >= 50) return "C";
  if (percent >= PASS_MARK) return "D";
  return "F";
}

// Is there an approved request letting this teacher reopen one sheet?
async function openRequest(teacherId, subjectId, examName, sectionId) {
  return await queryOne(
    `SELECT * FROM result_requests
      WHERE teacher_id = $1 AND subject_id = $2 AND exam_name = $3
        AND section_id = $4 AND status = 'approved'
      ORDER BY decided_at DESC
      LIMIT 1`,
    [teacherId, subjectId, examName, sectionId]
  );
}

// ------------------------------------------------------------------
// GET /api/results/exams  -> the exam names everyone chooses from
// ------------------------------------------------------------------
router.get("/exams", function (req, res) {
  res.json(EXAMS);
});

// ------------------------------------------------------------------
// GET /api/results/entry?class_id=&section_id=&subject_id=&exam_name=
// The marks sheet. A teacher may only type into it if nothing is saved
// yet, or if the admin approved a change request.
// ------------------------------------------------------------------
router.get("/entry", allow("teacher", "admin"), async function (req, res) {
  try {
    const { class_id, section_id, subject_id, exam_name } = req.query;

    if (!class_id || !section_id || !subject_id || !exam_name) {
      return res.status(400).json({ message: "Choose class, section, subject and exam." });
    }

    if (req.user.role === "teacher") {
      const ok = await teacherOwnsSubject(req.user.id, class_id, section_id, subject_id);
      if (!ok) {
        return res.status(403).json({
          message: "You do not teach that subject in this section.",
        });
      }
    }

    const rows = await query(
      `SELECT s.id AS student_id, u.full_name AS name,
              r.obtained_marks, r.total_marks
         FROM students s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN results r
                ON r.student_id = s.id AND r.subject_id = $3 AND r.exam_name = $4
        WHERE s.class_id = $1 AND s.section_id = $2 AND s.status = 'active'
        ORDER BY u.full_name`,
      [class_id, section_id, subject_id, exam_name]
    );

    const submitted = rows.some(function (r) { return r.obtained_marks !== null; });

    let canEdit = !submitted;
    let requestStatus = null;

    if (req.user.role === "teacher") {
      const teacher = await getTeacherOfUser(req.user.id);

      if (submitted) {
        const approved = await openRequest(teacher.id, subject_id, exam_name, section_id);
        canEdit = Boolean(approved);
        if (approved) requestStatus = "approved";
      }

      // Is a request already waiting for the admin?
      if (!canEdit) {
        const waiting = await queryOne(
          `SELECT id FROM result_requests
            WHERE teacher_id = $1 AND subject_id = $2 AND exam_name = $3
              AND section_id = $4 AND status = 'pending'`,
          [teacher.id, subject_id, exam_name, section_id]
        );
        if (waiting) requestStatus = "pending";
      }
    }

    // The admin can look at any sheet but cannot type into it.
    if (req.user.role === "admin") canEdit = false;

    const existingTotal = rows.find(function (r) { return r.total_marks !== null; });

    res.json({
      submitted: submitted,
      can_edit: canEdit,
      request_status: requestStatus,
      total_marks: existingTotal ? Number(existingTotal.total_marks) : 100,
      students: rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the marks sheet." });
  }
});

// ------------------------------------------------------------------
// POST /api/results   (teachers only - the admin never types marks)
// ------------------------------------------------------------------
router.post("/", allow("teacher"), async function (req, res) {
  try {
    const { class_id, section_id, subject_id, exam_name, marks } = req.body;
    const totalMarks = Number(req.body.total_marks);

    if (!class_id || !section_id || !subject_id || !exam_name) {
      return res.status(400).json({ message: "Choose class, section, subject and exam." });
    }
    if (!Array.isArray(marks) || marks.length === 0) {
      return res.status(400).json({ message: "Nothing to save." });
    }
    if (!isRealExam(exam_name)) {
      return res.status(400).json({ message: "That is not one of the school's exams." });
    }
    if (isNaN(totalMarks) || totalMarks < 1 || totalMarks > 200) {
      return res.status(400).json({ message: "Total marks for a paper must be between 1 and 200." });
    }

    const ok = await teacherOwnsSubject(req.user.id, class_id, section_id, subject_id);
    if (!ok) {
      return res.status(403).json({
        message: "You do not teach that subject in this section, so you cannot enter its marks.",
      });
    }

    for (const m of marks) {
      const obtained = Number(m.obtained_marks);
      if (isNaN(obtained) || obtained < 0 || obtained > totalMarks) {
        return res.status(400).json({
          message: "Every mark must be between 0 and " + totalMarks + ".",
        });
      }
    }

    const teacher = await getTeacherOfUser(req.user.id);

    // Already submitted? Then an approved request is required.
    const existing = await queryOne(
      `SELECT COUNT(*)::int AS n FROM results
        WHERE subject_id = $1 AND exam_name = $2 AND student_id = ANY($3::int[])`,
      [subject_id, exam_name, marks.map(function (m) { return m.student_id; })]
    );

    let usedRequest = null;

    if (existing.n > 0) {
      usedRequest = await openRequest(teacher.id, subject_id, exam_name, section_id);

      if (!usedRequest) {
        return res.status(403).json({
          message: "These marks were already submitted. Send a change request to the admin first.",
        });
      }
    }

    for (const m of marks) {
      await query(
        `INSERT INTO results (student_id, subject_id, exam_name, total_marks, obtained_marks)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (student_id, subject_id, exam_name)
         DO UPDATE SET obtained_marks = EXCLUDED.obtained_marks,
                       total_marks    = EXCLUDED.total_marks`,
        [m.student_id, subject_id, exam_name, totalMarks, Number(m.obtained_marks)]
      );
    }

    // An approved request opens the sheet once. Close it again now.
    if (usedRequest) {
      await query("UPDATE result_requests SET status = 'used' WHERE id = $1", [usedRequest.id]);
    }

    const parents = await query(
      `SELECT DISTINCT pu.id AS parent_user_id, u.full_name AS student_name
         FROM students s
         JOIN users u ON u.id = s.user_id
         JOIN parents p ON p.id = s.parent_id
         JOIN users pu  ON pu.id = p.user_id
        WHERE s.id = ANY($1::int[])`,
      [marks.map(function (m) { return m.student_id; })]
    );

    for (const p of parents) {
      await notify(
        p.parent_user_id,
        exam_name + " result published",
        "New marks have been added for " + p.student_name + ".",
        "result"
      );
    }

    res.json({
      message: usedRequest ? "Marks corrected. The sheet is locked again." : "Marks submitted.",
      saved: marks.length,
    });

    const sheet = await queryOne(
      `SELECT c.name AS class_name, sec.name AS section_name, sub.name AS subject_name
         FROM classes c, sections sec, subjects sub
        WHERE c.id = $1 AND sec.id = $2 AND sub.id = $3`,
      [class_id, section_id, subject_id]
    );
    if (sheet) {
      logAudit(
        req.user, usedRequest ? "corrected" : "submitted", "result",
        sheet.subject_name + " - " + sheet.class_name + " Section " + sheet.section_name,
        exam_name + ", " + marks.length + " students, out of " + totalMarks
      );
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not save the marks." });
  }
});

// ------------------------------------------------------------------
// CHANGE REQUESTS
// ------------------------------------------------------------------

// POST /api/results/requests   (teacher asks to reopen one sheet)
router.post("/requests", allow("teacher"), async function (req, res) {
  try {
    const { class_id, section_id, subject_id, exam_name, reason } = req.body;

    if (!class_id || !section_id || !subject_id || !exam_name || !reason) {
      return res.status(400).json({ message: "Say which sheet, and why it needs changing." });
    }

    const ok = await teacherOwnsSubject(req.user.id, class_id, section_id, subject_id);
    if (!ok) {
      return res.status(403).json({ message: "You do not teach that subject in this section." });
    }

    const teacher = await getTeacherOfUser(req.user.id);

    const waiting = await queryOne(
      `SELECT id FROM result_requests
        WHERE teacher_id = $1 AND subject_id = $2 AND exam_name = $3
          AND section_id = $4 AND status IN ('pending','approved')`,
      [teacher.id, subject_id, exam_name, section_id]
    );
    if (waiting) {
      return res.status(400).json({ message: "You already have a request open for this sheet." });
    }

    const rows = await query(
      `INSERT INTO result_requests
         (teacher_id, class_id, section_id, subject_id, exam_name, reason)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [teacher.id, class_id, section_id, subject_id, exam_name, reason]
    );

    const detail = await queryOne(
      `SELECT u.full_name AS teacher, c.name AS class_name,
              sec.name AS section_name, sub.name AS subject_name
         FROM teachers t
         JOIN users u      ON u.id = t.user_id
         JOIN classes c    ON c.id = $2
         JOIN sections sec ON sec.id = $3
         JOIN subjects sub ON sub.id = $4
        WHERE t.id = $1`,
      [teacher.id, class_id, section_id, subject_id]
    );

    const admins = await query("SELECT id FROM users WHERE role = 'admin' AND is_active = TRUE");

    for (const a of admins) {
      await notify(
        a.id,
        "Result change request from " + detail.teacher,
        detail.teacher + " wants to change " + detail.subject_name + " marks for " +
          detail.class_name + " - Section " + detail.section_name + " (" + exam_name +
          "). Reason: " + reason,
        "result"
      );
    }

    res.status(201).json({
      message: "Request sent. The admin will decide, and you will be notified.",
      request: rows[0],
    });

    logAudit(req.user, "requested", "result_change", req.body.exam_name || "A result sheet", req.body.reason || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not send the request." });
  }
});

// GET /api/results/requests  (admin sees all, a teacher sees their own)
router.get("/requests", allow("admin", "teacher"), async function (req, res) {
  try {
    let teacherId = null;

    if (req.user.role === "teacher") {
      const teacher = await getTeacherOfUser(req.user.id);
      if (!teacher) return res.json([]);
      teacherId = teacher.id;
    }

    const rows = await query(
      `SELECT rr.*, u.full_name AS teacher_name,
              c.name AS class_name, sec.name AS section_name, sub.name AS subject_name
         FROM result_requests rr
         JOIN teachers t   ON t.id = rr.teacher_id
         JOIN users u      ON u.id = t.user_id
         JOIN classes c    ON c.id = rr.class_id
         JOIN sections sec ON sec.id = rr.section_id
         JOIN subjects sub ON sub.id = rr.subject_id
        WHERE ($1::int IS NULL OR rr.teacher_id = $1)
        ORDER BY (rr.status = 'pending') DESC, rr.created_at DESC
        LIMIT 100`,
      [teacherId]
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the requests." });
  }
});

// POST /api/results/requests/:id/decide   (admin approves or rejects)
router.post("/requests/:id/decide", allow("admin"), async function (req, res) {
  try {
    const approve = req.body.approve === true || req.body.approve === "true";
    const note = req.body.admin_note || null;

    const request = await queryOne("SELECT * FROM result_requests WHERE id = $1", [req.params.id]);
    if (!request) return res.status(404).json({ message: "Request not found." });
    if (request.status !== "pending") {
      return res.status(400).json({ message: "This request was already decided." });
    }

    await query(
      `UPDATE result_requests
          SET status = $1, admin_note = $2, decided_at = NOW()
        WHERE id = $3`,
      [approve ? "approved" : "rejected", note, request.id]
    );

    const teacherUser = await queryOne(
      `SELECT u.id, sub.name AS subject_name
         FROM teachers t
         JOIN users u ON u.id = t.user_id
         JOIN subjects sub ON sub.id = $2
        WHERE t.id = $1`,
      [request.teacher_id, request.subject_id]
    );

    if (teacherUser) {
      await notify(
        teacherUser.id,
        approve ? "Result change approved" : "Result change refused",
        approve
          ? "You can now correct the " + teacherUser.subject_name + " marks for " +
            request.exam_name + ". The sheet locks again once you submit." +
            (note ? " Note: " + note : "")
          : "The admin did not approve the change." + (note ? " Note: " + note : ""),
        "result"
      );
    }

    res.json({ message: approve ? "Request approved." : "Request rejected." });

    logAudit(
      req.user, approve ? "approved" : "rejected", "result_change",
      request.exam_name + (teacherUser ? " - " + teacherUser.subject_name : ""), note
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not save the decision." });
  }
});

// ------------------------------------------------------------------
// GET /api/results/class?class_id=&section_id=&exam_name=[&subject_id=]
// The whole class for one exam, with totals, grades and positions.
// ------------------------------------------------------------------
router.get("/class", allow("admin", "teacher"), async function (req, res) {
  try {
    const { class_id, section_id, exam_name, subject_id } = req.query;

    if (!class_id || !section_id || !exam_name) {
      return res.status(400).json({ message: "Choose class, section and exam." });
    }

    if (req.user.role === "teacher") {
      const ok = await teacherOwnsSection(req.user.id, class_id, section_id);
      if (!ok) return res.status(403).json({ message: "You are not assigned to this section." });
    }

    const rows = await query(
      `SELECT s.id AS student_id, u.full_name AS name, s.admission_no,
              sub.name AS subject_name, r.obtained_marks, r.total_marks
         FROM students s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN results r
                ON r.student_id = s.id AND r.exam_name = $3
               AND ($4::int IS NULL OR r.subject_id = $4)
         LEFT JOIN subjects sub ON sub.id = r.subject_id
        WHERE s.class_id = $1 AND s.section_id = $2 AND s.status = 'active'
        ORDER BY u.full_name, sub.name`,
      [class_id, section_id, exam_name, subject_id || null]
    );

    // Gather the rows into one entry per student.
    const byStudent = {};
    const subjectNames = [];

    for (const r of rows) {
      if (!byStudent[r.student_id]) {
        byStudent[r.student_id] = {
          student_id: r.student_id,
          name: r.name,
          admission_no: r.admission_no,
          subjects: {},
          total: 0,
          obtained: 0,
        };
      }

      if (r.subject_name) {
        byStudent[r.student_id].subjects[r.subject_name] = {
          obtained: Number(r.obtained_marks),
          total: Number(r.total_marks),
        };
        byStudent[r.student_id].total += Number(r.total_marks);
        byStudent[r.student_id].obtained += Number(r.obtained_marks);

        if (!subjectNames.includes(r.subject_name)) subjectNames.push(r.subject_name);
      }
    }

    subjectNames.sort();

    const students = Object.values(byStudent).map(function (st) {
      const percent = st.total === 0 ? 0 : (st.obtained / st.total) * 100;

      const failedSubjects = Object.keys(st.subjects).filter(function (name) {
        const sub = st.subjects[name];
        return (sub.obtained / sub.total) * 100 < PASS_MARK;
      });

      return {
        ...st,
        has_result: st.total > 0,
        percentage: Math.round(percent * 100) / 100,
        grade: grade(percent),
        failed_subjects: failedSubjects,
        status:
          st.total === 0
            ? "No result"
            : failedSubjects.length === 0 && percent >= PASS_MARK
            ? "Pass"
            : "Fail",
      };
    });

    // Position: highest marks first. Equal marks share a position.
    const ranked = students
      .filter(function (s) { return s.has_result; })
      .sort(function (a, b) { return b.obtained - a.obtained; });

    let lastMarks = null;
    let lastPosition = 0;

    ranked.forEach(function (s, index) {
      if (s.obtained !== lastMarks) {
        lastPosition = index + 1;
        lastMarks = s.obtained;
      }
      s.position = lastPosition;
    });

    const withResult = students.filter(function (s) { return s.has_result; });
    const passed = withResult.filter(function (s) { return s.status === "Pass"; });
    const failed = withResult.filter(function (s) { return s.status === "Fail"; });

    res.json({
      exam_name: exam_name,
      subjects: subjectNames,
      students: students.sort(function (a, b) {
        return (a.position || 9999) - (b.position || 9999);
      }),
      summary: {
        total_students: students.length,
        with_result: withResult.length,
        passed: passed.length,
        failed: failed.length,
        pass_rate:
          withResult.length === 0
            ? 0
            : Math.round((passed.length / withResult.length) * 100),
        class_average:
          withResult.length === 0
            ? 0
            : Math.round(
                (withResult.reduce(function (sum, s) { return sum + s.percentage; }, 0) /
                  withResult.length) * 100
              ) / 100,
      },
      position_holders: ranked.slice(0, 3),
      passed: passed,
      failed: failed,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not build the class result." });
  }
});

// ------------------------------------------------------------------
// GET /api/results/student/:id  -> report card grouped by exam
// ------------------------------------------------------------------
router.get("/student/:id", async function (req, res) {
  try {
    const id = Number(req.params.id);

    if (req.user.role === "student") {
      const me = await getStudentOfUser(req.user.id);
      if (!me || me.id !== id) {
        return res.status(403).json({ message: "You can only view your own result." });
      }
    }
    if (req.user.role === "parent") {
      const ok = await parentOwnsStudent(req.user.id, id);
      if (!ok) return res.status(403).json({ message: "That is not your child." });
    }

    const rows = await query(
      `SELECT r.exam_name, r.total_marks, r.obtained_marks, sub.name AS subject_name
         FROM results r
         JOIN subjects sub ON sub.id = r.subject_id
        WHERE r.student_id = $1
        ORDER BY r.exam_name, sub.name`,
      [id]
    );

    const exams = {};

    for (const r of rows) {
      if (!exams[r.exam_name]) {
        exams[r.exam_name] = { exam_name: r.exam_name, subjects: [], total: 0, obtained: 0 };
      }
      const percent = (Number(r.obtained_marks) / Number(r.total_marks)) * 100;

      exams[r.exam_name].subjects.push({
        subject_name: r.subject_name,
        total_marks: Number(r.total_marks),
        obtained_marks: Number(r.obtained_marks),
        grade: grade(percent),
        passed: percent >= PASS_MARK,
      });
      exams[r.exam_name].total += Number(r.total_marks);
      exams[r.exam_name].obtained += Number(r.obtained_marks);
    }

    const list = Object.values(exams).map(function (e) {
      const percent = e.total === 0 ? 0 : (e.obtained / e.total) * 100;
      const anyFail = e.subjects.some(function (s) { return !s.passed; });

      return {
        ...e,
        percentage: Math.round(percent * 100) / 100,
        grade: grade(percent),
        status: !anyFail && percent >= PASS_MARK ? "Pass" : "Fail",
      };
    });

    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the result." });
  }
});

module.exports = router;
