const express = require("express");
const crypto = require("crypto");
const { query, queryOne } = require("../db");
const {
  hashPassword,
  checkPassword,
  makeToken,
  requireLogin,
  allow,
} = require("../auth");
const {
  cleanPhone, parentClash, emailOwner, staffEmail, phoneIdentity, phoneProblem, logAudit, notify, uploadImage,
} = require("../helpers");

const router = express.Router();

// How long an approved password request stays usable before it lapses.
const APPROVAL_WINDOW_HOURS = 24;

// The secret "ref" handed to the requester's browser is only ever stored
// as a hash, the same way a session token normally is.
function hashRef(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// POST /api/auth/login
router.post("/login", async function (req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Enter your email or registration number, and your password." });
    }

    // $1 is matched against the email, or against a student's admission number
    const user = await queryOne(
      `SELECT u.*
         FROM users u
         LEFT JOIN students s ON s.user_id = u.id
        WHERE LOWER(u.email) = LOWER($1)
           OR s.admission_no = $1`,
      [email]
    );

    if (!user || !checkPassword(password, user.password)) {
      logAudit(
        { id: user ? user.id : null, name: user ? user.full_name : String(email).slice(0, 100), role: user ? user.role : "public" },
        "failed_signin", "session", String(email).slice(0, 150),
        user ? "Wrong password" : "No account matches this login"
      );
      return res.status(401).json({ message: "Login or password is wrong." });
    }

    if (!user.is_active) {
      logAudit(
        { id: user.id, name: user.full_name, role: user.role },
        "failed_signin", "session", user.full_name, "Account is disabled"
      );
      return res.status(403).json({ message: "This account has been disabled." });
    }

    logAudit({ id: user.id, name: user.full_name, role: user.role }, "signed_in", "session", user.full_name);

    res.json({
      token: makeToken(user),
      user: {
        id: user.id,
        name: user.full_name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not log in. Try again." });
  }
});

// GET /api/auth/me  -> who am I, plus a few role-specific ids
router.get("/me", requireLogin, async function (req, res) {
  try {
    const user = await queryOne(
      "SELECT id, full_name, email, phone, role, photo FROM users WHERE id = $1",
      [req.user.id]
    );

    if (!user) return res.status(404).json({ message: "Account not found." });

    const out = { ...user, name: user.full_name };

    if (user.role === "student") {
      out.student = await queryOne(
        `SELECT s.id, s.admission_no, s.class_id, s.section_id,
                c.name AS class_name, sec.name AS section_name
           FROM students s
           LEFT JOIN classes c   ON c.id = s.class_id
           LEFT JOIN sections sec ON sec.id = s.section_id
          WHERE s.user_id = $1`,
        [user.id]
      );
    }

    if (user.role === "parent") {
      const parent = await queryOne("SELECT * FROM parents WHERE user_id = $1", [user.id]);
      out.parent = parent;
      out.children = parent
        ? await query(
            `SELECT s.id, u.full_name AS name, s.admission_no,
                    s.class_id, s.section_id,
                    c.name AS class_name, sec.name AS section_name
               FROM students s
               JOIN users u ON u.id = s.user_id
               LEFT JOIN classes c    ON c.id = s.class_id
               LEFT JOIN sections sec ON sec.id = s.section_id
              WHERE s.parent_id = $1
              ORDER BY u.full_name`,
            [parent.id]
          )
        : [];
    }

    if (user.role === "teacher") {
      out.teacher = await queryOne("SELECT * FROM teachers WHERE user_id = $1", [user.id]);
    }

    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load your profile." });
  }
});

// PUT /api/auth/profile
// Anyone who is signed in can correct their own name, phone and email.
// Staff addresses stay on @school.com.
// Profile picture. Everyone sets their own; the admin can also set one for a
// student (young children often do not sign in themselves).
//   PUT    /api/auth/photo            own picture   (form field "photo")
//   DELETE /api/auth/photo            remove own picture
//   PUT    /api/auth/photo/:userId    admin sets someone's picture
//   DELETE /api/auth/photo/:userId    admin removes it
async function savePhoto(req, res, userId, photo) {
  const target = await queryOne("SELECT id, full_name FROM users WHERE id = $1", [userId]);
  if (!target) return res.status(404).json({ message: "Account not found." });

  await query("UPDATE users SET photo = $1 WHERE id = $2", [photo, userId]);

  logAudit(req.user, photo ? "updated" : "removed", "profile_picture", target.full_name);
  res.json({ message: photo ? "Picture saved." : "Picture removed.", photo: photo });
}

router.put("/photo", requireLogin, uploadImage.single("photo"), async function (req, res) {
  try {
    if (!req.file) return res.status(400).json({ message: "Choose a picture first." });
    await savePhoto(req, res, req.user.id, req.file.filename);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not save the picture." });
  }
});

router.delete("/photo", requireLogin, async function (req, res) {
  try {
    await savePhoto(req, res, req.user.id, null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not remove the picture." });
  }
});

router.put("/photo/:userId", requireLogin, allow("admin"), uploadImage.single("photo"), async function (req, res) {
  try {
    if (!req.file) return res.status(400).json({ message: "Choose a picture first." });
    await savePhoto(req, res, Number(req.params.userId), req.file.filename);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not save the picture." });
  }
});

router.delete("/photo/:userId", requireLogin, allow("admin"), async function (req, res) {
  try {
    await savePhoto(req, res, Number(req.params.userId), null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not remove the picture." });
  }
});

router.put("/profile", requireLogin, async function (req, res) {
  try {
    const { full_name, phone, email } = req.body;

    if (!full_name || full_name.trim().length < 3) {
      return res.status(400).json({ message: "Enter your full name." });
    }

    const me = await queryOne("SELECT * FROM users WHERE id = $1", [req.user.id]);

    // ---- phone ----
    let newPhone = me.phone;

    if (phone !== undefined && phone !== me.phone) {
      newPhone = cleanPhone(phone);
      if (phone && !newPhone) {
        return res.status(400).json({
          message: "Enter a Pakistani mobile number, for example 0300 1234567.",
        });
      }

      // The number must be free, or already belong to this same person in
      // another role. Students are exempt: they share a parent's number.
      if (newPhone && me.role !== "student") {
        const phoneCheck = await phoneIdentity(newPhone, full_name, me.role, me.id);
        const phoneMessage = phoneProblem(phoneCheck, newPhone);
        if (phoneMessage) return res.status(400).json({ message: phoneMessage });
      }
    }

    // ---- email ----
    let newEmail = me.email;

    if (email && email.toLowerCase() !== me.email.toLowerCase()) {
      newEmail = me.role === "admin" || me.role === "teacher" ? staffEmail(email) : email.trim();

      if (!newEmail) {
        return res.status(400).json({
          message: "Staff addresses end in @school.com. Enter the part before the @.",
        });
      }

      const owner = await emailOwner(newEmail, me.id);
      if (owner) {
        return res.status(400).json({
          message: "That email already belongs to " + owner.full_name +
            " (" + owner.role + "). Every account needs its own.",
        });
      }
    }

    await query(
      "UPDATE users SET full_name = $1, phone = $2, email = $3 WHERE id = $4",
      [full_name.trim(), newPhone, newEmail, me.id]
    );

    res.json({
      message: newEmail !== me.email
        ? "Saved. Sign in with " + newEmail + " next time."
        : "Your details have been saved.",
      email: newEmail,
    });

    logAudit(req.user, "updated", "profile", full_name.trim(), "Changed their own details");
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not save your details." });
  }
});

// POST /api/auth/change-password
router.post("/change-password", requireLogin, async function (req, res) {
  try {
    const { oldPassword, newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ message: "New password must be at least 6 characters." });
    }

    const user = await queryOne("SELECT * FROM users WHERE id = $1", [req.user.id]);

    if (!checkPassword(oldPassword || "", user.password)) {
      return res.status(400).json({ message: "Your current password is wrong." });
    }

    await query("UPDATE users SET password = $1 WHERE id = $2", [
      hashPassword(newPassword),
      user.id,
    ]);

    res.json({ message: "Password changed." });

    logAudit(req.user, "changed", "password", user.full_name, "Changed their own password");
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not change the password." });
  }
});

module.exports = router;
