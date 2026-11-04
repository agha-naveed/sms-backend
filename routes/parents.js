const express = require("express");
const { query, queryOne } = require("../db");
const { requireLogin, allow, hashPassword } = require("../auth");
const {
  cleanPhone, cleanCnic, parentClash, emailOwner, phoneIdentity, phoneProblem, logAudit, randomPassword,
} = require("../helpers");

const router = express.Router();
router.use(requireLogin, allow("admin"));

// GET /api/parents
router.get("/", async function (req, res) {
  try {
    const rows = await query(
      `SELECT p.id, p.cnic, p.occupation, p.address,
              u.full_name AS name, u.email, u.phone,
              (SELECT COUNT(*)::int FROM students s WHERE s.parent_id = p.id) AS children
         FROM parents p
         JOIN users u ON u.id = p.user_id
        ORDER BY u.full_name`
    );
    // attach each parent's children so the admin can see the family together
    for (const parent of rows) {
      parent.students = await query(
        `SELECT s.id, s.admission_no, u.full_name AS name, u.email,
                c.name AS class_name, sec.name AS section_name
           FROM students s
           JOIN users u ON u.id = s.user_id
           LEFT JOIN classes c    ON c.id = s.class_id
           LEFT JOIN sections sec ON sec.id = s.section_id
          WHERE s.parent_id = $1
          ORDER BY u.full_name`,
        [parent.id]
      );
    }

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load parents." });
  }
});

// POST /api/parents
router.post("/", async function (req, res) {
  try {
    const { name, email, password, phone, cnic, occupation, address } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: "Name, email and password are required." });
    }

    const owner = await emailOwner(email, null);
    if (owner) {
      return res.status(400).json({
        message: "This email is already taken",
      });
    }

    const cleanedPhone = cleanPhone(phone);
    if (phone && !cleanedPhone) {
      return res.status(400).json({
        message: "Enter a Pakistani mobile number, for example 0300 1234567.",
      });
    }

    const cleanedCnic = cleanCnic(cnic);
    if (cnic && !cleanedCnic) {
      return res.status(400).json({ message: "A CNIC must have 13 digits." });
    }

    const phoneCheck = await phoneIdentity(cleanedPhone, name, "parent", null);
    const phoneMessage = phoneProblem(phoneCheck, cleanedPhone);
    if (phoneMessage) return res.status(400).json({ message: phoneMessage });

    const clash = await parentClash(cleanedCnic, cleanedPhone, null);
    if (clash) {
      return res.status(400).json({
        message: "That " + clash.field + " already belongs to " + clash.name +
          " (" + clash.email + "). Each parent account needs its own.",
      });
    }

    const user = await query(
      `INSERT INTO users (full_name, email, password, phone, role)
       VALUES ($1,$2,$3,$4,'parent') RETURNING id`,
      [name, email, hashPassword(password), cleanedPhone]
    );

    const rows = await query(
      "INSERT INTO parents (user_id, cnic, occupation, address) VALUES ($1,$2,$3,$4) RETURNING *",
      [user[0].id, cleanedCnic, occupation || null, address || null]
    );

    res.status(201).json(rows[0]);

    logAudit(req.user, "created", "parent", name + " (" + email + ")");
  } catch (err) {
    // 23505 is the unique-index error, in case two forms are saved at once.
    if (err.code === "23505") {
      return res.status(400).json({
        message: "That CNIC or mobile number is already used by another parent.",
      });
    }
    console.error(err);
    res.status(500).json({ message: "Could not add the parent." });
  }
});

// PUT /api/parents/:id/reset-password  (admin)
// Recovers a parent's password with a new temporary one, shown once to the
// admin. It does not change their children's own logins.
router.put("/:id/reset-password", allow("admin"), async function (req, res) {
  try {
    const parent = await queryOne(
      "SELECT p.*, u.full_name AS name FROM parents p JOIN users u ON u.id = p.user_id WHERE p.id = $1",
      [req.params.id]
    );
    if (!parent) return res.status(404).json({ message: "Parent not found." });

    const newPassword = randomPassword();
    await query("UPDATE users SET password = $1 WHERE id = $2", [hashPassword(newPassword), parent.user_id]);

    res.json({ message: "Password reset.", password: newPassword });

    logAudit(req.user, "reset", "password", parent.name + " (parent)");
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not reset the password." });
  }
});

module.exports = router;
