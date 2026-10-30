const express = require("express");
const { pool, query, queryOne } = require("../db");
const {
  requireLogin,
  allow,
  hashPassword,
  parentOwnsStudent,
  getStudentOfUser,
} = require("../auth");
const {
  cleanPhone, cleanCnic, DEFAULT_PASSWORD, nextAdmissionNo, schoolEmail, parentClash,
  emailOwner, phoneIdentity, phoneProblem, logAudit, randomPassword, parentSchoolEmail,
} = require("../helpers");

const router = express.Router();
router.use(requireLogin);

// GET /api/students?class_id=&section_id=&search=
// Admin sees everyone. A teacher only sees students in a section they teach.
router.get("/", allow("admin", "teacher"), async function (req, res) {
  try {
    const { class_id, section_id, search } = req.query;

    let sql = `
      SELECT s.id, s.admission_no, s.status, s.gender, s.class_id, s.section_id,
             u.full_name AS name, u.email, u.phone,
             c.name AS class_name, sec.name AS section_name,
             pu.full_name AS parent_name, pu.phone AS parent_phone
        FROM students s
        JOIN users u ON u.id = s.user_id
        LEFT JOIN classes c    ON c.id = s.class_id
        LEFT JOIN sections sec ON sec.id = s.section_id
        LEFT JOIN parents p    ON p.id = s.parent_id
        LEFT JOIN users pu     ON pu.id = p.user_id
       WHERE ($1::int IS NULL OR s.class_id = $1)
         AND ($2::int IS NULL OR s.section_id = $2)
         AND ($3::text IS NULL OR u.full_name ILIKE '%' || $3 || '%'
              OR s.admission_no ILIKE '%' || $3 || '%')`;

    const values = [class_id || null, section_id || null, search || null];

    // A teacher is limited to their own class + section list.
    if (req.user.role === "teacher") {
      sql += `
         AND EXISTS (
           SELECT 1 FROM teacher_classes tc
             JOIN teachers t ON t.id = tc.teacher_id
            WHERE t.user_id = $4
              AND tc.class_id = s.class_id
              AND tc.section_id = s.section_id
         )`;
      values.push(req.user.id);
    }

    sql += " ORDER BY c.id, sec.name, u.full_name";

    res.json(await query(sql, values));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load students." });
  }
});

// GET /api/students/:id  -> full profile
// Students see only themselves, parents only their own children.
router.get("/:id", async function (req, res) {
  try {
    const id = Number(req.params.id);

    if (req.user.role === "student") {
      const me = await getStudentOfUser(req.user.id);
      if (!me || me.id !== id) {
        return res.status(403).json({ message: "You can only view your own profile." });
      }
    }
    if (req.user.role === "parent") {
      const ok = await parentOwnsStudent(req.user.id, id);
      if (!ok) return res.status(403).json({ message: "That is not your child." });
    }

    // A teacher can look up a student in a section they teach, nobody else.
    // The profile carries the family's contact details, so it is not open
    // to every member of staff.
    if (req.user.role === "teacher") {
      const mine = await queryOne(
        `SELECT s.id
           FROM students s
           JOIN teacher_classes tc
             ON tc.class_id = s.class_id AND tc.section_id = s.section_id
           JOIN teachers t ON t.id = tc.teacher_id
          WHERE t.user_id = $1 AND s.id = $2
          LIMIT 1`,
        [req.user.id, id]
      );
      if (!mine) {
        return res.status(403).json({ message: "That student is not in one of your classes." });
      }
    }

    const student = await queryOne(
      `SELECT s.*, u.full_name AS name, u.email, u.phone,
              c.name AS class_name, sec.name AS section_name,
              pu.full_name AS parent_name, pu.phone AS parent_phone, pu.email AS parent_email
         FROM students s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN classes c    ON c.id = s.class_id
         LEFT JOIN sections sec ON sec.id = s.section_id
         LEFT JOIN parents p    ON p.id = s.parent_id
         LEFT JOIN users pu     ON pu.id = p.user_id
        WHERE s.id = $1`,
      [id]
    );

    if (!student) return res.status(404).json({ message: "Student not found." });
    res.json(student);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the student." });
  }
});

// POST /api/students
// Adds a student who already attends the school, without an admission form.
// The registration number, login email and password are made for you, and a
// parent account can be created in the same step.
router.post("/", allow("admin"), async function (req, res) {
  const client = await pool.connect();

  try {
    const b = req.body;

    if (!b.name || !b.class_id || !b.section_id) {
      return res.status(400).json({ message: "Name, class and section are required." });
    }

    // Either link an existing parent, or make one from the details given.
    let parentId = b.parent_id || null;
    let parentLogin = null;

    const phone = cleanPhone(b.phone);
    if (b.phone && !phone) {
      return res.status(400).json({
        message: "Enter a Pakistani mobile number, for example 0300 1234567.",
      });
    }

    // Registration number and login are generated unless the admin typed one.
    const admissionNo = b.admission_no || (await nextAdmissionNo());

    await client.query("BEGIN");

    // A parent is made from the details given. The same CNIC means the same
    // parent, so a second child is linked to the existing account. A parent
    // with no email of their own gets a school email made from the
    // registration number.
    if (!parentId && (b.parent_name || b.parent_email || b.parent_cnic)) {
      const parentPhone = cleanPhone(b.parent_phone);
      if (b.parent_phone && !parentPhone) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Check the parent's mobile number." });
      }

      const parentCnic = cleanCnic(b.parent_cnic);
      if (b.parent_cnic && !parentCnic) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "A CNIC must have 13 digits." });
      }

      if (parentCnic) {
        const sameCnic = await queryOne(
          "SELECT p.id, u.email FROM parents p JOIN users u ON u.id = p.user_id WHERE p.cnic = $1 LIMIT 1",
          [parentCnic]
        );
        if (sameCnic) {
          parentId = sameCnic.id;
          parentLogin = { email: sameCnic.email, password: "(existing account, unchanged)" };
        }
      }

      if (!parentId) {
        if (!b.parent_name) {
          await client.query("ROLLBACK");
          return res.status(400).json({ message: "Enter the parent's name." });
        }

        const parentEmail = (b.parent_email || "").trim() || parentSchoolEmail(admissionNo);

        // Reuse the account if that email already signs in here.
        let parentUser = await queryOne("SELECT * FROM users WHERE LOWER(email) = LOWER($1)", [
          parentEmail,
        ]);

        if (parentUser && parentUser.role !== "parent") {
          await client.query("ROLLBACK");
          return res.status(400).json({
            message: parentEmail + " is already used by " + parentUser.full_name +
              " (" + parentUser.role + ").",
          });
        }

        if (!parentUser) {
          const phoneCheck = await phoneIdentity(parentPhone, b.parent_name, "parent", null);
          const phoneMessage = phoneProblem(phoneCheck, parentPhone);
          if (phoneMessage) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: phoneMessage });
          }

          // A mobile number belongs to one parent only.
          const clash = await parentClash(null, parentPhone, null);
          if (clash) {
            await client.query("ROLLBACK");
            return res.status(400).json({
              message: "That " + clash.field + " already belongs to " + clash.name +
                " (" + clash.email + "). Use \"Link an existing parent\" instead.",
            });
          }

          const made = await client.query(
            `INSERT INTO users (full_name, email, password, phone, role)
             VALUES ($1,$2,$3,$4,'parent') RETURNING *`,
            [b.parent_name, parentEmail, hashPassword(DEFAULT_PASSWORD), parentPhone]
          );
          parentUser = made.rows[0];
          parentLogin = { email: parentEmail, password: DEFAULT_PASSWORD };
        } else {
          parentLogin = { email: parentEmail, password: "(existing account, unchanged)" };
        }

        let parent = await queryOne("SELECT * FROM parents WHERE user_id = $1", [parentUser.id]);

        if (!parent) {
          const made = await client.query(
            "INSERT INTO parents (user_id, cnic, address) VALUES ($1,$2,$3) RETURNING *",
            [parentUser.id, parentCnic, b.address || null]
          );
          parent = made.rows[0];
        }

        parentId = parent.id;
      }
    }

    // The registration number must not already belong to another student.
    const clash = await queryOne("SELECT id FROM students WHERE admission_no = $1", [admissionNo]);
    if (clash) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "That registration number is already used." });
    }

    const email = b.email || schoolEmail(admissionNo);

    const taken = await queryOne("SELECT id FROM users WHERE LOWER(email) = LOWER($1)", [email]);
    if (taken) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "That email is already used." });
    }

    const studentUser = await client.query(
      `INSERT INTO users (full_name, email, password, phone, role)
       VALUES ($1,$2,$3,$4,'student') RETURNING id`,
      [b.name, email, hashPassword(DEFAULT_PASSWORD), phone]
    );

    const rows = await client.query(
      `INSERT INTO students
         (user_id, parent_id, class_id, section_id, admission_no, gender, dob, address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        studentUser.rows[0].id,
        parentId,
        b.class_id,
        b.section_id,
        admissionNo,
        b.gender || null,
        b.dob || null,
        b.address || null,
      ]
    );

    await client.query("COMMIT");

    res.status(201).json({
      message: "Student added.",
      student: rows[0],
      admission_no: admissionNo,
      student_login: { email: email, password: DEFAULT_PASSWORD },
      parent_login: parentLogin,
    });

    logAudit(req.user, "created", "student", b.name + " (" + admissionNo + ")");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ message: "Could not add the student." });
  } finally {
    client.release();
  }
});

// PUT /api/students/:id  -> admin edits class, section and other details
router.put("/:id", allow("admin"), async function (req, res) {
  try {
    const b = req.body;

    const student = await queryOne("SELECT * FROM students WHERE id = $1", [req.params.id]);
    if (!student) return res.status(404).json({ message: "Student not found." });

    await query(
      `UPDATE students
          SET class_id = $1, section_id = $2, gender = $3,
              dob = $4, address = $5, parent_id = $6, status = $7
        WHERE id = $8`,
      [
        b.class_id || null,
        b.section_id || null,
        b.gender || null,
        b.dob || null,
        b.address || null,
        b.parent_id || null,
        b.status || student.status,
        req.params.id,
      ]
    );

    if (b.name || b.phone) {
      await query(
        "UPDATE users SET full_name = COALESCE($1, full_name), phone = COALESCE($2, phone) WHERE id = $3",
        [b.name || null, b.phone || null, student.user_id]
      );
    }

    res.json({ message: "Student updated." });

    const who = await queryOne("SELECT u.full_name AS name FROM users u WHERE u.id = $1", [student.user_id]);
    logAudit(req.user, "updated", "student", (who ? who.name : "Student") + " (" + student.admission_no + ")");
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not save the student." });
  }
});

// POST /api/students/:id/promote  -> move to another class + section
router.post("/:id/promote", allow("admin"), async function (req, res) {
  try {
    const { class_id, section_id } = req.body;
    if (!class_id || !section_id) {
      return res.status(400).json({ message: "Choose the new class and section." });
    }
    await query("UPDATE students SET class_id = $1, section_id = $2 WHERE id = $3", [
      class_id,
      section_id,
      req.params.id,
    ]);
    res.json({ message: "Student moved." });

    const moved = await queryOne(
      `SELECT u.full_name AS name, s.admission_no, c.name AS class_name, sec.name AS section_name
         FROM students s JOIN users u ON u.id = s.user_id, classes c, sections sec
        WHERE s.id = $1 AND c.id = $2 AND sec.id = $3`,
      [req.params.id, class_id, section_id]
    );
    if (moved) {
      logAudit(req.user, "moved", "student", moved.name + " (" + moved.admission_no + ")",
        "To " + moved.class_name + " - Section " + moved.section_name);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not move the student." });
  }
});

module.exports = router;
