// Days the school is closed: public holidays, summer and winter vacation,
// local holidays, and the weekly off days (Saturday, Sunday or both).
// No attendance is taken, and none is counted, on these days.
const express = require("express");
const { query, queryOne } = require("../db");
const { requireLogin, allow } = require("../auth");
const { HOLIDAY_KINDS, WEEKLY_OFF_DAYS, getWeeklyOff, getAttendanceWindow, logAudit } = require("../helpers");

const router = express.Router();
router.use(requireLogin);

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/holidays  -> everyone signed in may look at the school calendar
router.get("/", async function (req, res) {
  try {
    const rows = await query(
      `SELECT id, kind, title, note,
              TO_CHAR(start_date, 'YYYY-MM-DD') AS start_date,
              TO_CHAR(end_date, 'YYYY-MM-DD')   AS end_date
         FROM school_holidays
        ORDER BY start_date DESC, id DESC`
    );
    res.json({
      weekly_off: await getWeeklyOff(),
      kinds: Object.keys(HOLIDAY_KINDS).map(function (k) { return { value: k, label: HOLIDAY_KINDS[k] }; }),
      holidays: rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the holidays." });
  }
});

// PUT /api/holidays/weekly-off  { weekly_off: "none"|"saturday"|"sunday"|"both" }
router.put("/weekly-off", allow("admin"), async function (req, res) {
  try {
    const value = req.body.weekly_off;
    if (!WEEKLY_OFF_DAYS[value]) {
      return res.status(400).json({ message: "Choose none, Saturday, Sunday, or both." });
    }

    const existing = await queryOne("SELECT id FROM school_settings ORDER BY id LIMIT 1");
    if (existing) {
      await query("UPDATE school_settings SET weekly_off = $1 WHERE id = $2", [value, existing.id]);
    } else {
      const w = await getAttendanceWindow();
      await query(
        "INSERT INTO school_settings (attendance_start, attendance_end, weekly_off) VALUES ($1,$2,$3)",
        [w.start, w.end, value]
      );
    }

    res.json({ message: "Weekly off days saved.", weekly_off: value });
    logAudit(req.user, "updated", "settings", "Weekly off days", value);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not save the weekly off days." });
  }
});

// POST /api/holidays  { kind, title, start_date, end_date?, note? }
router.post("/", allow("admin"), async function (req, res) {
  try {
    const { kind, note } = req.body;
    const start = req.body.start_date;
    const end = req.body.end_date || start;

    if (!HOLIDAY_KINDS[kind]) {
      return res.status(400).json({ message: "Choose what kind of closure this is." });
    }
    if (!DATE.test(start || "") || !DATE.test(end || "")) {
      return res.status(400).json({ message: "Choose the date (or the first and last date)." });
    }
    if (end < start) {
      return res.status(400).json({ message: "The last date cannot be before the first date." });
    }

    const title = String(req.body.title || "").trim() || HOLIDAY_KINDS[kind];

    const rows = await query(
      `INSERT INTO school_holidays (kind, title, start_date, end_date, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, kind, title, note,
                 TO_CHAR(start_date, 'YYYY-MM-DD') AS start_date,
                 TO_CHAR(end_date, 'YYYY-MM-DD')   AS end_date`,
      [kind, title, start, end, note ? String(note).trim() : null, req.user.id]
    );

    res.status(201).json(rows[0]);
    logAudit(req.user, "created", "holiday", title, start + " to " + end);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not save the holiday." });
  }
});

// DELETE /api/holidays/:id
router.delete("/:id", allow("admin"), async function (req, res) {
  try {
    const row = await queryOne("DELETE FROM school_holidays WHERE id = $1 RETURNING title", [req.params.id]);
    if (!row) return res.status(404).json({ message: "Holiday not found." });
    res.json({ message: "Holiday removed." });
    logAudit(req.user, "deleted", "holiday", row.title);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not remove the holiday." });
  }
});

module.exports = router;
