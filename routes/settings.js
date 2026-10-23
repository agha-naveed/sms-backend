// School-wide settings. Right now this is just the daily window attendance
// can be marked in, but it is its own file so more settings can join it
// later without cluttering another route.
const express = require("express");
const { query, queryOne } = require("../db");
const { requireLogin, allow } = require("../auth");
const { getAttendanceWindow, logAudit } = require("../helpers");

const router = express.Router();
router.use(requireLogin);

// GET /api/settings  -> every logged-in role may read it (teachers need to
// know the window, parents and students do not mind either way).
router.get("/", async function (req, res) {
  try {
    const window = await getAttendanceWindow();
    res.json({ attendance_start: window.start, attendance_end: window.end });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load settings." });
  }
});

// PUT /api/settings  { attendance_start: "07:00", attendance_end: "11:00" }
router.put("/", allow("admin"), async function (req, res) {
  try {
    const { attendance_start, attendance_end } = req.body;
    const pattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

    if (!pattern.test(attendance_start) || !pattern.test(attendance_end)) {
      return res.status(400).json({ message: "Enter both times as HH:MM, for example 07:00." });
    }
    if (attendance_start >= attendance_end) {
      return res.status(400).json({ message: "The start time must be before the end time." });
    }

    const existing = await queryOne("SELECT id FROM school_settings ORDER BY id LIMIT 1");

    if (existing) {
      await query(
        "UPDATE school_settings SET attendance_start = $1, attendance_end = $2 WHERE id = $3",
        [attendance_start, attendance_end, existing.id]
      );
    } else {
      await query(
        "INSERT INTO school_settings (attendance_start, attendance_end) VALUES ($1, $2)",
        [attendance_start, attendance_end]
      );
    }

    res.json({ message: "Attendance window updated.", attendance_start, attendance_end });

    logAudit(req.user, "updated", "settings", "Attendance window", attendance_start + " to " + attendance_end);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not save settings." });
  }
});

module.exports = router;
