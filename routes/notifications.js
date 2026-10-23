const express = require("express");
const { query, queryOne } = require("../db");
const { requireLogin } = require("../auth");

const router = express.Router();
router.use(requireLogin);

// GET /api/notifications?unread=1
router.get("/", async function (req, res) {
  try {
    const rows = await query(
      `SELECT * FROM notifications
        WHERE user_id = $1
          AND ($2::boolean IS NULL OR is_read = FALSE)
        ORDER BY created_at DESC
        LIMIT 100`,
      [req.user.id, req.query.unread ? true : null]
    );

    const count = await queryOne(
      "SELECT COUNT(*)::int AS unread FROM notifications WHERE user_id = $1 AND is_read = FALSE",
      [req.user.id]
    );

    res.json({ unread: count.unread, items: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load notifications." });
  }
});

// POST /api/notifications/:id/read
router.post("/:id/read", async function (req, res) {
  try {
    await query("UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2", [
      req.params.id,
      req.user.id,
    ]);
    res.json({ message: "Marked as read." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not update the notification." });
  }
});

// POST /api/notifications/read-all
router.post("/read-all", async function (req, res) {
  try {
    await query("UPDATE notifications SET is_read = TRUE WHERE user_id = $1", [req.user.id]);
    res.json({ message: "All marked as read." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not update notifications." });
  }
});

module.exports = router;
