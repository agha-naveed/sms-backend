const express = require("express");
const { query, queryOne } = require("../db");
const { requireLogin, allow } = require("../auth");
const { notify, logAudit } = require("../helpers");

const router = express.Router();
router.use(requireLogin);

// ------------------------------------------------------------------
// NOTICES  (admin writes, roles read)
// ------------------------------------------------------------------

// GET /api/notices  -> only the notices meant for my role
router.get("/", async function (req, res) {
  try {
    const rows = await query(
      `SELECT n.*, u.full_name AS posted_by
         FROM notices n
         LEFT JOIN users u ON u.id = n.created_by
        WHERE $1 = 'admin' OR n.audience = 'all' OR n.audience = $1
        ORDER BY n.is_important DESC, n.created_at DESC`,
      [req.user.role]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load notices." });
  }
});

// POST /api/notices  (admin)
// An important notice is also pushed to each person's notification list.
router.post("/", allow("admin"), async function (req, res) {
  try {
    const { title, body, audience, is_important } = req.body;

    if (!title || !body) {
      return res.status(400).json({ message: "Enter a title and a message." });
    }

    const rows = await query(
      `INSERT INTO notices (title, body, audience, is_important, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [title, body, audience || "all", Boolean(is_important), req.user.id]
    );

    if (is_important) {
      const target = audience && audience !== "all" ? audience : null;
      const people = await query(
        `SELECT id FROM users
          WHERE is_active = TRUE
            AND role <> 'admin'
            AND ($1::text IS NULL OR role = $1)`,
        [target]
      );
      for (const p of people) {
        await notify(p.id, title, body, "general");
      }
    }

    res.status(201).json(rows[0]);

    logAudit(req.user, "created", "notice", title, is_important ? "Marked important" : null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not post the notice." });
  }
});

// DELETE /api/notices/:id  (admin)
router.delete("/:id", allow("admin"), async function (req, res) {
  try {
    const notice = await queryOne("SELECT title FROM notices WHERE id = $1", [req.params.id]);
    await query("DELETE FROM notices WHERE id = $1", [req.params.id]);
    res.json({ message: "Notice deleted." });

    if (notice) logAudit(req.user, "deleted", "notice", notice.title);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not delete the notice." });
  }
});

module.exports = router;
