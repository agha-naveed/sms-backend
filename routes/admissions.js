const express = require("express");
const { pool, query, queryOne } = require("../db");
const { requireLogin, allow, hashPassword } = require("../auth");
const {
  upload, notify, cleanPhone, cleanCnic,
  DEFAULT_PASSWORD, nextAdmissionNo, schoolEmail, parentClash, emailOwner,
  parentIdentity, phoneIdentity, phoneProblem, logAudit,
} = require("../helpers");

const router = express.Router();

// Gives a brand new account the notices that were posted before they joined,
// newest first, so their notice list is not empty on day one.
async function sendOldNotices(userId, role) {
  const notices = await query(
    `SELECT title, body FROM notices
      WHERE audience = 'all' OR audience = $1
      ORDER BY created_at DESC
      LIMIT 10`,
    [role]
  );

  for (const n of notices) {
    await notify(userId, n.title, n.body, "general");
  }
}

// The number printed on the applicant's copy of the form. It is worked out
// from the row id, so nothing extra has to be stored.
function formNo(application) {
  const year = new Date(application.created_at).getFullYear();
  return "APP-" + year + "-" + String(application.id).padStart(4, "0");
}

// ------------------------------------------------------------------
// PUBLIC: anyone can send an application (no login needed)
// POST /api/admissions/apply
// ------------------------------------------------------------------
router.post("/apply", upload.single("document"), async function (req, res) {
  try {
    const b = req.body;

    if (!b.student_name || !b.parent_name || !b.parent_email) {
      return res
        .status(400)
        .json({ message: "Student name, parent name and parent email are required." });
    }

    // Phone and CNIC are stored in one fixed shape.
    const phone = cleanPhone(b.parent_phone);
    if (b.parent_phone && !phone) {
      return res.status(400).json({
        message: "Enter a Pakistani mobile number, for example 0300 1234567.",
      });
    }

    const cnic = cleanCnic(b.parent_cnic);
    if (b.parent_cnic && !cnic) {
      return res.status(400).json({ message: "A CNIC must have 13 digits." });
    }

    // The number must not already belong to a different person.
    if (phone) {
      const phoneCheck = await phoneIdentity(phone, b.parent_name, "parent", null);
      if (phoneCheck.status === "conflict") {
        return res.status(400).json({
          message: "This mobile number is already registered to a different person. " +
            "Check the number, or contact the school office.",
        });
      }
    }

    // A CNIC belongs to one parent. If it is already here under a different
    // name or email, this is somebody else's number.
    if (cnic) {
      const identity = await parentIdentity(cnic, b.parent_name, b.parent_email);

      if (identity.status === "conflict") {
        return res.status(400).json({
          message: "This CNIC is already registered to a different person. The " +
            identity.differs.join(" and ") +
            " on this form do not match it. Check the CNIC, or contact the school office.",
        });
      }
    }

    // A child cannot be born tomorrow. Checked here as well as in the browser,
    // because anyone can send a request straight to the server.
    if (b.dob) {
      const dob = new Date(b.dob);
      const today = new Date();
      today.setHours(23, 59, 59, 999);

      if (isNaN(dob.getTime())) {
        return res.status(400).json({ message: "That date of birth is not a real date." });
      }
      if (dob > today) {
        return res.status(400).json({ message: "The date of birth cannot be in the future." });
      }
      if (dob.getFullYear() < 1990) {
        return res.status(400).json({ message: "Please check the date of birth." });
      }
    }

    // A parent may apply for more than one child, so the email alone is not
    // enough to call something a duplicate. What we block is the same child
    // being sent twice. A rejected application can be sent again.
    const duplicate = await queryOne(
      `SELECT id, status FROM admissions
        WHERE LOWER(parent_email) = LOWER($1)
          AND LOWER(TRIM(student_name)) = LOWER(TRIM($2))
          AND status <> 'rejected'`,
      [b.parent_email, b.student_name]
    );

    if (duplicate) {
      return res.status(400).json({
        message:
          duplicate.status === "approved"
            ? b.student_name + " has already been admitted using this email."
            : "An application for " + b.student_name +
              " was already sent from this email and is waiting for review.",
      });
    }

    // The same child must not already be studying here under this parent.
    const alreadyStudying = await queryOne(
      `SELECT s.id
         FROM students s
         JOIN users u  ON u.id = s.user_id
         JOIN parents p ON p.id = s.parent_id
         JOIN users pu ON pu.id = p.user_id
        WHERE LOWER(pu.email) = LOWER($1)
          AND LOWER(TRIM(u.full_name)) = LOWER(TRIM($2))`,
      [b.parent_email, b.student_name]
    );

    if (alreadyStudying) {
      return res.status(400).json({
        message: b.student_name + " is already enrolled at the school.",
      });
    }

    const rows = await query(
      `INSERT INTO admissions
         (student_name, gender, dob, applying_class_id, parent_name,
          parent_email, parent_phone, parent_cnic, address, document)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [
        b.student_name,
        b.gender || null,
        b.dob || null,
        b.applying_class_id || null,
        b.parent_name,
        b.parent_email,
        phone,
        cnic,
        b.address || null,
        req.file ? req.file.filename : null,
      ]
    );

    const saved = await queryOne("SELECT * FROM admissions WHERE id = $1", [rows[0].id]);

    res.status(201).json({
      message: "Application received. The school will contact you after review.",
      id: saved.id,
      form_no: formNo(saved),
      submitted_on: saved.created_at,
      student_name: saved.student_name,
      parent_name: saved.parent_name,
      parent_email: saved.parent_email,
      parent_phone: saved.parent_phone,
      applying_class_id: saved.applying_class_id,
    });

    // Nobody is signed in here, so the entry is attributed to the public.
    logAudit(
      { id: null, name: saved.parent_name, role: "public" },
      "submitted", "admission_form", saved.student_name + " (" + formNo(saved) + ")",
      "Applying for class id " + saved.applying_class_id
    );
  } catch (err) {
    // 23505 is the unique-index error, in case two forms arrive at once.
    if (err.code === "23505") {
      return res.status(400).json({
        message: "An application for this student has already been sent from this email.",
      });
    }
    console.error(err);
    res.status(500).json({ message: "Could not send the application." });
  }
});

// PUBLIC: called while the admission form is being filled, once the CNIC has
// all 13 digits. It answers whether this CNIC is free, belongs to the same
// parent, or belongs to somebody else.
// GET /api/admissions/check-parent?cnic=&name=&email=
router.get("/check-parent", async function (req, res) {
  try {
    const cnic = cleanCnic(req.query.cnic);

    if (!cnic) {
      return res.json({ status: "incomplete", message: "A CNIC has 13 digits." });
    }

    const result = await parentIdentity(cnic, req.query.name, req.query.email);

    if (result.status === "free") {
      return res.json({ status: "free", message: "This CNIC is not registered yet." });
    }

    if (result.status === "match") {
      return res.json({
        status: "match",
        message: "This CNIC is already registered with the same name and email. " +
          "The new child will be added to that same parent account.",
      });
    }

    // Deliberately vague about whose it is: this endpoint is public, so it
    // must not turn a CNIC into a way of looking up a name or an email.
    return res.json({
      status: "conflict",
      differs: result.differs,
      message: "This CNIC is already registered to a different person. The " +
        result.differs.join(" and ") +
        " on this form do not match it. Check the CNIC, or contact the school office.",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not check the CNIC." });
  }
});

// PUBLIC: the result board. Anyone can look up one application, but only
// with something they already know: the form number, the registration
// number, the exact email, or the child's full name. Partial names are not
// accepted, so the whole list cannot be walked through from outside.
// GET /api/admissions/check?q=APP-2026-0007
router.get("/check", async function (req, res) {
  try {
    const q = String(req.query.q || "").trim();

    if (q.length < 3) {
      return res.status(400).json({ message: "Type your form number, registration number, email or full name." });
    }

    // "APP-2026-0007" carries the row id in its last part.
    let idFromForm = null;
    const parts = q.toUpperCase().split("-");
    if (parts[0] === "APP" && parts.length === 3) {
      idFromForm = Number(parts[2]);
      if (isNaN(idFromForm)) idFromForm = null;
    }

    const rows = await query(
      `SELECT a.id, a.student_name, a.status, a.remarks, a.created_at,
              a.student_email, c.name AS applying_class,
              s.admission_no, sec.name AS section_name
         FROM admissions a
         LEFT JOIN classes c ON c.id = a.applying_class_id
         LEFT JOIN users su  ON LOWER(su.email) = LOWER(a.student_email)
         LEFT JOIN students s ON s.user_id = su.id
         LEFT JOIN sections sec ON sec.id = s.section_id
        WHERE a.id = $1
           OR LOWER(a.parent_email) = LOWER($2)
           OR LOWER(TRIM(a.student_name)) = LOWER(TRIM($2))
           OR s.admission_no = $2
        ORDER BY a.created_at DESC
        LIMIT 10`,
      [idFromForm, q]
    );

    // The form number is a search key, not something to display. If it came
    // back in the response, searching somebody's name would hand out the key
    // to look them up again, so it is left out entirely.
    res.json(
      rows.map(function (r) {
        return {
          student_name: r.student_name,
          applying_class: r.applying_class,
          status: r.status,
          remarks: r.remarks,
          created_at: r.created_at,
          // Only an accepted student gets their joining details shown.
          admission_no: r.status === "approved" ? r.admission_no : null,
          section_name: r.status === "approved" ? r.section_name : null,
          login_email: r.status === "approved" ? r.student_email : null,
        };
      })
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not check that." });
  }
});

// PUBLIC: check application status by email
// GET /api/admissions/status?email=...
router.get("/status", async function (req, res) {
  try {
    const rows = await query(
      `SELECT a.id, a.student_name, a.status, a.remarks, a.created_at,
              c.name AS applying_class
         FROM admissions a
         LEFT JOIN classes c ON c.id = a.applying_class_id
        WHERE LOWER(a.parent_email) = LOWER($1)
        ORDER BY a.created_at DESC`,
      [req.query.email || ""]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not check the status." });
  }
});

// ------------------------------------------------------------------
// ADMIN ONLY from here down
// ------------------------------------------------------------------
router.use(requireLogin, allow("admin"));

// GET /api/admissions?status=pending
router.get("/", async function (req, res) {
  try {
    const status = req.query.status;
    const rows = await query(
      `SELECT a.*, c.name AS applying_class
         FROM admissions a
         LEFT JOIN classes c ON c.id = a.applying_class_id
        WHERE ($1::text IS NULL OR a.status = $1)
        ORDER BY a.created_at DESC`,
      [status || null]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load applications." });
  }
});

// POST /api/admissions/:id/approve
// Creates the parent account (or reuses it) and the student account.
// Returns the new passwords once so the admin can pass them on.
router.post("/:id/approve", async function (req, res) {
  const client = await pool.connect();
  try {
    const { class_id, section_id } = req.body;

    if (!class_id || !section_id) {
      return res.status(400).json({ message: "Choose a class and a section." });
    }

    const app = await queryOne("SELECT * FROM admissions WHERE id = $1", [req.params.id]);
    if (!app) return res.status(404).json({ message: "Application not found." });
    if (app.status !== "pending") {
      return res.status(400).json({ message: "This application was already reviewed." });
    }

    await client.query("BEGIN");

    // --- parent account ---
    // The same parent may apply for a second child using a different email, so
    // the CNIC and mobile number are checked too. If either already belongs to
    // a parent here, that account is used instead of making a duplicate.
    let parentUser = await queryOne("SELECT * FROM users WHERE LOWER(email) = LOWER($1)", [
      app.parent_email,
    ]);

    // If that address is a teacher or the admin, it cannot become a parent too.
    if (parentUser && parentUser.role !== "parent") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        message: app.parent_email + " is already used by " + parentUser.full_name +
          " (" + parentUser.role + "). Ask the family for a different email.",
      });
    }

    if (!parentUser && app.parent_cnic) {
      // Reuse an existing parent ONLY when the CNIC, the name and the email
      // all agree. Matching on the CNIC alone was wrong: it quietly attached
      // a different father's child to somebody else's account.
      const identity = await parentIdentity(app.parent_cnic, app.parent_name, app.parent_email);

      if (identity.status === "conflict") {
        await client.query("ROLLBACK");
        return res.status(400).json({
          message: "CNIC " + app.parent_cnic + " is already registered to " +
            identity.parent.full_name + " (" + identity.parent.email + "). The " +
            identity.differs.join(" and ") + " on this application do not match. " +
            "Correct the application, or link the student to the existing parent by hand.",
        });
      }

      if (identity.status === "match") {
        parentUser = await queryOne("SELECT * FROM users WHERE id = $1", [identity.parent.user_id]);
      }
    }

    // Making a brand new parent account? The number must be free, or belong
    // to the same person in another role.
    if (!parentUser && app.parent_phone) {
      const phoneCheck = await phoneIdentity(app.parent_phone, app.parent_name, "parent", null);
      const phoneMessage = phoneProblem(phoneCheck, app.parent_phone);

      if (phoneMessage) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: phoneMessage });
      }
    }

    let parentPassword = null;

    if (!parentUser) {
      parentPassword = DEFAULT_PASSWORD;
      const inserted = await client.query(
        `INSERT INTO users (full_name, email, password, phone, role)
         VALUES ($1,$2,$3,$4,'parent') RETURNING *`,
        [app.parent_name, app.parent_email, hashPassword(parentPassword), app.parent_phone]
      );
      parentUser = inserted.rows[0];
    }

    let parent = await queryOne("SELECT * FROM parents WHERE user_id = $1", [parentUser.id]);

    // The CNIC on the form may already belong to a different parent here.
    if (!parent && app.parent_cnic) {
      const clash = await parentClash(app.parent_cnic, null, null);
      if (clash) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          message: "CNIC " + app.parent_cnic + " already belongs to " + clash.name +
            " (" + clash.email + "). One CNIC belongs to one parent account.",
        });
      }
    }

    if (!parent) {
      const inserted = await client.query(
        `INSERT INTO parents (user_id, cnic, address) VALUES ($1,$2,$3) RETURNING *`,
        [parentUser.id, app.parent_cnic, app.address]
      );
      parent = inserted.rows[0];
    }

    // --- student account ---
    const admissionNo = await nextAdmissionNo();
    // The registration number is already unique, so it is the whole address.
    // 2026-0001 becomes 2026-0001@school.com
    const studentEmail = schoolEmail(admissionNo);
    const studentPassword = DEFAULT_PASSWORD;

    const studentUser = await client.query(
      `INSERT INTO users (full_name, email, password, phone, role)
       VALUES ($1,$2,$3,$4,'student') RETURNING *`,
      [app.student_name, studentEmail, hashPassword(studentPassword), app.parent_phone]
    );

    await client.query(
      `INSERT INTO students
         (user_id, parent_id, class_id, section_id, admission_no, gender, dob, address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        studentUser.rows[0].id,
        parent.id,
        class_id,
        section_id,
        admissionNo,
        app.gender,
        app.dob,
        app.address,
      ]
    );

    await client.query(
      "UPDATE admissions SET status = 'approved', student_email = $1 WHERE id = $2",
      [studentEmail, app.id]
    );

    await client.query("COMMIT");

    await notify(
      parentUser.id,
      "Admission approved",
      app.student_name + " has been admitted. Admission number " + admissionNo + ".",
      "general"
    );

    await notify(
      studentUser.rows[0].id,
      "Welcome to the school",
      "Your registration number is " + admissionNo + ". You can sign in with that " +
        "number or with " + studentEmail + ".",
      "general"
    );

    // Notices posted before this family joined would otherwise be invisible to
    // them, so the recent ones are copied into their notification list.
    await sendOldNotices(studentUser.rows[0].id, "student");
    await sendOldNotices(parentUser.id, "parent");

    res.json({
      message: "Admission approved and accounts created.",
      admission_no: admissionNo,
      student_login: { email: studentEmail, password: studentPassword },
      parent_login: parentPassword
        ? { email: app.parent_email, password: parentPassword }
        : { email: app.parent_email, password: "(existing account, password unchanged)" },
    });

    logAudit(req.user, "approved", "admission", app.student_name + " (" + admissionNo + ")");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ message: "Could not approve the application." });
  } finally {
    client.release();
  }
});

// POST /api/admissions/:id/reject
router.post("/:id/reject", async function (req, res) {
  try {
    const app = await queryOne("SELECT student_name FROM admissions WHERE id = $1", [req.params.id]);
    const rows = await query(
      `UPDATE admissions SET status = 'rejected', remarks = $1
        WHERE id = $2 AND status = 'pending' RETURNING id`,
      [req.body.remarks || "No reason given.", req.params.id]
    );
    if (rows.length === 0) {
      return res.status(400).json({ message: "This application was already reviewed." });
    }
    res.json({ message: "Application rejected." });

    if (app) logAudit(req.user, "rejected", "admission", app.student_name, req.body.remarks || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not reject the application." });
  }
});

module.exports = router;
