const express = require("express");
const { query, queryOne } = require("../db");
const { requireLogin, allow, hashPassword, getTeacherOfUser } = require("../auth");
const {
  cleanPhone, staffEmail, emailOwner, phoneIdentity, phoneProblem, logAudit, randomPassword,
} = require("../helpers");

const router = express.Router();
router.use(requireLogin);

// GET /api/teachers/my-classes
// The class + section list a logged-in teacher is allowed to work with.
// Used by the attendance page and the assignment form.
router.get("/my-classes", allow("teacher"), async function (req, res) {
  try {
    const teacher = await getTeacherOfUser(req.user.id);
    if (!teacher) return res.json([]);

    // Every section the teacher teaches in, plus the one they are class
    // teacher of, each with the number of active students in it.
    const rows = await query(
      `SELECT x.class_id, x.section_id, c.name AS class_name, sec.name AS section_name,
              (SELECT COUNT(*)::int FROM students s
                WHERE s.class_id = x.class_id AND s.section_id = x.section_id
                  AND s.status = 'active') AS student_count
         FROM (
           SELECT class_id, section_id FROM teacher_classes WHERE teacher_id = $1
           UNION
           SELECT class_id, id AS section_id FROM sections WHERE class_teacher_id = $1
         ) x
         JOIN classes c    ON c.id = x.class_id
         JOIN sections sec ON sec.id = x.section_id
        ORDER BY c.name, sec.name`,
      [teacher.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load your classes." });
  }
});

// GET /api/teachers/my-class-teacher-sections
// The section(s) this teacher is the class teacher of. Only these sections
// can have their attendance marked by this teacher. Normally this is one
// section, since a teacher can be class teacher of only one.
router.get("/my-class-teacher-sections", allow("teacher"), async function (req, res) {
  try {
    const teacher = await getTeacherOfUser(req.user.id);
    if (!teacher) return res.json([]);

    const rows = await query(
      `SELECT sec.class_id, sec.id AS section_id,
              c.name AS class_name, sec.name AS section_name,
              (SELECT COUNT(*)::int FROM students s
                WHERE s.class_id = sec.class_id AND s.section_id = sec.id
                  AND s.status = 'active') AS student_count
         FROM sections sec
         JOIN classes c ON c.id = sec.class_id
        WHERE sec.class_teacher_id = $1
        ORDER BY c.name, sec.name`,
      [teacher.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load your class." });
  }
});

// GET /api/teachers/section?class_id=&section_id=
// The subject and teacher list for one section. Students, parents and
// teachers all use this to see who teaches what.
router.get("/section", async function (req, res) {
  try {
    const { class_id, section_id } = req.query;

    if (!class_id || !section_id) {
      return res.status(400).json({ message: "Choose a class and a section." });
    }

    // Every subject of the class, with the teacher if one is assigned.
    const rows = await query(
      `SELECT sub.id AS subject_id, sub.name AS subject_name,
              u.full_name AS teacher_name, u.email AS teacher_email,
              t.qualification
         FROM subjects sub
         LEFT JOIN teacher_classes tc
                ON tc.subject_id = sub.id AND tc.section_id = $2
         LEFT JOIN teachers t ON t.id = tc.teacher_id
         LEFT JOIN users u    ON u.id = t.user_id
        WHERE sub.class_id = $1
        ORDER BY sub.name`,
      [class_id, section_id]
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the subject list." });
  }
});

// GET /api/teachers/my-subjects?class_id=&section_id=
// Only the subjects this teacher actually takes in that section, so the
// marks form cannot offer somebody else's subject in the first place.
router.get("/my-subjects", allow("teacher"), async function (req, res) {
  try {
    const { class_id, section_id } = req.query;
    if (!class_id || !section_id) {
      return res.status(400).json({ message: "Choose a class and a section." });
    }

    const teacher = await getTeacherOfUser(req.user.id);
    if (!teacher) return res.json([]);

    // A row with no subject means this teacher takes the whole section.
    const wholeSection = await queryOne(
      `SELECT id FROM teacher_classes
        WHERE teacher_id = $1 AND class_id = $2 AND section_id = $3
          AND subject_id IS NULL
        LIMIT 1`,
      [teacher.id, class_id, section_id]
    );

    if (wholeSection) {
      return res.json(
        await query("SELECT id, name FROM subjects WHERE class_id = $1 ORDER BY name", [class_id])
      );
    }

    res.json(
      await query(
        `SELECT DISTINCT sub.id, sub.name
           FROM teacher_classes tc
           JOIN subjects sub ON sub.id = tc.subject_id
          WHERE tc.teacher_id = $1 AND tc.class_id = $2 AND tc.section_id = $3
          ORDER BY sub.name`,
        [teacher.id, class_id, section_id]
      )
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load your subjects." });
  }
});

// ------------------------------------------------------------------
// ADMIN ONLY below
// ------------------------------------------------------------------

// GET /api/teachers
router.get("/", allow("admin"), async function (req, res) {
  try {
    const rows = await query(
      `SELECT t.id, t.qualification, t.joining_date,
              u.id AS user_id, u.full_name AS name, u.email, u.phone, u.is_active
         FROM teachers t
         JOIN users u ON u.id = t.user_id
        ORDER BY u.full_name`
    );

    // attach the class list and the class-teacher section (if any) of each teacher
    for (const t of rows) {
      t.classes = await query(
        `SELECT tc.id, c.name AS class_name, sec.name AS section_name, sub.name AS subject_name
           FROM teacher_classes tc
           JOIN classes c    ON c.id = tc.class_id
           JOIN sections sec ON sec.id = tc.section_id
           LEFT JOIN subjects sub ON sub.id = tc.subject_id
          WHERE tc.teacher_id = $1
          ORDER BY c.name, sec.name`,
        [t.id]
      );

      t.class_teacher_of = await queryOne(
        `SELECT c.name AS class_name, sec.name AS section_name
           FROM sections sec
           JOIN classes c ON c.id = sec.class_id
          WHERE sec.class_teacher_id = $1`,
        [t.id]
      );
    }

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load teachers." });
  }
});

// POST /api/teachers  -> creates the login and the teacher record together
router.post("/", allow("admin"), async function (req, res) {
  try {
    const { name, email, password, phone, qualification } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: "Name, email and password are required." });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters." });
    }

    // Staff sign in with a school address. The admin types the name part and
    // @school.com is added here, so an outside address cannot slip in.
    const address = staffEmail(email);
    if (!address) {
      return res.status(400).json({
        message: "Enter the part before the @, at least 3 letters. It becomes name@school.com.",
      });
    }

    const owner = await emailOwner(address, null);
    if (owner) {
      return res.status(400).json({
        message: address + " already belongs to " + owner.full_name + " (" + owner.role + ").",
      });
    }

    const cleanedPhone = cleanPhone(phone);
    if (phone && !cleanedPhone) {
      return res.status(400).json({
        message: "Enter a Pakistani mobile number, for example 0300 1234567.",
      });
    }

    // No two teachers share a number. The same person may already be a parent
    // here, and that is allowed as long as the name matches.
    const phoneCheck = await phoneIdentity(cleanedPhone, name, "teacher", null);
    const phoneMessage = phoneProblem(phoneCheck, cleanedPhone);
    if (phoneMessage) return res.status(400).json({ message: phoneMessage });

    const user = await query(
      `INSERT INTO users (full_name, email, password, phone, role)
       VALUES ($1,$2,$3,$4,'teacher') RETURNING id`,
      [name, address, hashPassword(password), cleanedPhone]
    );

    const rows = await query(
      "INSERT INTO teachers (user_id, qualification) VALUES ($1,$2) RETURNING *",
      [user[0].id, qualification || null]
    );

    res.status(201).json({ ...rows[0], email: address });

    logAudit(req.user, "created", "teacher", name + " (" + address + ")");
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not add the teacher." });
  }
});

// POST /api/teachers/:id/classes
// body: { class_id, section_ids: [..], subject_ids: [..] }
// Assigns every chosen subject in every chosen section in one go, so the admin
// does not have to repeat the form once per subject.
router.post("/:id/classes", allow("admin"), async function (req, res) {
  try {
    const classId = req.body.class_id;

    // Accept a single id or a list, so older calls still work.
    const sectionIds = [].concat(req.body.section_ids || req.body.section_id || []);
    const subjectIds = [].concat(req.body.subject_ids || req.body.subject_id || []);

    if (!classId || sectionIds.length === 0) {
      return res.status(400).json({ message: "Choose a class and at least one section." });
    }

    // No subject chosen means the teacher takes the section for any subject.
    const subjects = subjectIds.length > 0 ? subjectIds : [null];

    let added = 0;
    let skipped = 0;
    const taken = [];

    for (const sectionId of sectionIds) {
      for (const subjectId of subjects) {
        // A subject in one section has exactly one teacher. If somebody else
        // already has it, say who, instead of silently doing nothing.
        if (subjectId) {
          const owner = await queryOne(
            `SELECT u.full_name AS teacher, sub.name AS subject, sec.name AS section
               FROM teacher_classes tc
               JOIN teachers t   ON t.id = tc.teacher_id
               JOIN users u      ON u.id = t.user_id
               JOIN subjects sub ON sub.id = tc.subject_id
               JOIN sections sec ON sec.id = tc.section_id
              WHERE tc.class_id = $1 AND tc.section_id = $2 AND tc.subject_id = $3
                AND tc.teacher_id <> $4`,
            [classId, sectionId, subjectId, req.params.id]
          );

          if (owner) {
            taken.push(owner.subject + " (Section " + owner.section + ") is taken by " + owner.teacher);
            continue;
          }
        }

        const rows = await query(
          `INSERT INTO teacher_classes (teacher_id, class_id, section_id, subject_id)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [req.params.id, classId, sectionId, subjectId || null]
        );

        if (rows.length > 0) added = added + 1;
        else skipped = skipped + 1;
      }
    }

    if (added === 0) {
      return res.status(400).json({
        message: taken.length > 0
          ? "Nothing was assigned. " + taken.join(". ") + "."
          : "This teacher already has all of those.",
      });
    }

    res.status(201).json({
      message:
        added + " assignment" + (added === 1 ? "" : "s") + " added." +
        (taken.length > 0 ? " Skipped: " + taken.join(". ") + "." : ""),
      added: added,
      already_had: skipped,
      taken: taken,
    });

    const who = await queryOne(
      "SELECT u.full_name AS name, c.name AS class_name FROM teachers t JOIN users u ON u.id = t.user_id, classes c WHERE t.id = $1 AND c.id = $2",
      [req.params.id, classId]
    );
    if (who) {
      logAudit(req.user, "assigned", "teacher_class", who.name + " to " + who.class_name,
        added + " assignment" + (added === 1 ? "" : "s") + " added");
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not assign the classes." });
  }
});

// DELETE /api/teachers/classes/:linkId
router.delete("/classes/:linkId", allow("admin"), async function (req, res) {
  try {
    const link = await queryOne(
      `SELECT u.full_name AS name, c.name AS class_name, sec.name AS section_name, sub.name AS subject_name
         FROM teacher_classes tc
         JOIN teachers t   ON t.id = tc.teacher_id
         JOIN users u      ON u.id = t.user_id
         JOIN classes c    ON c.id = tc.class_id
         JOIN sections sec ON sec.id = tc.section_id
         LEFT JOIN subjects sub ON sub.id = tc.subject_id
        WHERE tc.id = $1`,
      [req.params.linkId]
    );

    await query("DELETE FROM teacher_classes WHERE id = $1", [req.params.linkId]);
    res.json({ message: "Class removed from this teacher." });

    if (link) {
      logAudit(req.user, "unassigned", "teacher_class",
        link.name + " from " + link.class_name + " - Section " + link.section_name,
        link.subject_name ? "Subject: " + link.subject_name : "All subjects");
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not remove the class." });
  }
});

// PUT /api/teachers/:id/reset-password  (admin)
// Recovers a teacher's password with a new temporary one, shown once to the
// admin.
router.put("/:id/reset-password", allow("admin"), async function (req, res) {
  try {
    const teacher = await queryOne(
      "SELECT t.*, u.full_name AS name FROM teachers t JOIN users u ON u.id = t.user_id WHERE t.id = $1",
      [req.params.id]
    );
    if (!teacher) return res.status(404).json({ message: "Teacher not found." });

    const newPassword = randomPassword();
    await query("UPDATE users SET password = $1 WHERE id = $2", [hashPassword(newPassword), teacher.user_id]);

    res.json({ message: "Password reset.", password: newPassword });

    logAudit(req.user, "reset", "password", teacher.name + " (teacher)");
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not reset the password." });
  }
});

// DELETE /api/teachers/:id  -> removes the teacher and their login
router.delete("/:id", allow("admin"), async function (req, res) {
  try {
    const teacher = await queryOne(
      "SELECT t.*, u.full_name AS name FROM teachers t JOIN users u ON u.id = t.user_id WHERE t.id = $1",
      [req.params.id]
    );
    if (!teacher) return res.status(404).json({ message: "Teacher not found." });

    await query("DELETE FROM users WHERE id = $1", [teacher.user_id]); // cascades
    res.json({ message: "Teacher removed." });

    logAudit(req.user, "deleted", "teacher", teacher.name);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not remove the teacher." });
  }
});

module.exports = router;
