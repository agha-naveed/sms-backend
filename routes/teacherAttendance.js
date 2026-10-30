// Statuses: present, late (came in after the start time), absent, leave.
// Late counts as attended in the percentage but is reported on its own.
//
// Teacher attendance works like student attendance, but simpler: the admin
// marks it for everyone, there is no time window and no "class teacher"
// idea, since it's the admin doing the marking.
const express = require("express");
const { query, queryOne } = require("../db");
const { requireLogin, allow, getTeacherOfUser } = require("../auth");
const { notify, WEEKLY_HOLIDAY, DAY_NAMES, resolveRange, todayText, logAudit } = require("../helpers");

const router = express.Router();
router.use(requireLogin);

// GET /api/teacher-attendance/roster?date=2026-09-06
router.get("/roster", allow("admin"), async function (req, res) {
  try {
    const date = req.query.date || todayText();

    const teachers = await query(
      `SELECT t.id, u.full_name AS name, ta.status, ta.id AS attendance_id
         FROM teachers t
         JOIN users u ON u.id = t.user_id
         LEFT JOIN teacher_attendance ta ON ta.teacher_id = t.id AND ta.date = $1
        ORDER BY u.full_name`,
      [date]
    );

    const isHoliday = WEEKLY_HOLIDAY >= 0 && new Date(date + "T12:00:00").getDay() === WEEKLY_HOLIDAY;

    res.json({
      date: date,
      is_holiday: isHoliday,
      holiday_name: isHoliday ? DAY_NAMES[WEEKLY_HOLIDAY] : null,
      already_marked: teachers.some(function (t) { return t.attendance_id !== null; }),
      teachers: teachers,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the staff list." });
  }
});

// POST /api/teacher-attendance/mark
// { date, records: [{ teacher_id, status }] }
router.post("/mark", allow("admin"), async function (req, res) {
  try {
    const { records } = req.body;
    const date = req.body.date || todayText();

    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ message: "Nothing to save." });
    }

    const bad = records.some(function (r) { return !["present", "late", "absent", "leave"].includes(r.status); });
    if (bad) return res.status(400).json({ message: "Mark every teacher before you submit." });

    for (const r of records) {
      await query(
        `INSERT INTO teacher_attendance (teacher_id, date, status, marked_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (teacher_id, date)
         DO UPDATE SET status = EXCLUDED.status, marked_by = EXCLUDED.marked_by`,
        [r.teacher_id, date, r.status, req.user.id]
      );
    }

    const absent = records.filter(function (r) { return r.status === "absent"; }).length;
    const late = records.filter(function (r) { return r.status === "late"; }).length;

    res.json({ message: "Staff attendance submitted.", total: records.length, absent: absent, late: late });

    logAudit(req.user, "marked", "teacher_attendance", "Staff attendance for " + date, records.length + " teachers, " + absent + " absent, " + late + " late");
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not save staff attendance." });
  }
});

// GET /api/teacher-attendance/report?period=month&date=&teacher_id=
// The admin can see everyone, or one teacher. A teacher only ever sees
// their own record, whatever teacher_id is sent.
router.get("/report", allow("admin", "teacher"), async function (req, res) {
  try {
    const range = resolveRange(req.query.period, req.query.date, req.query.from, req.query.to);

    let teacherId = req.query.teacher_id ? Number(req.query.teacher_id) : null;

    if (req.user.role === "teacher") {
      const me = await getTeacherOfUser(req.user.id);
      if (!me) return res.status(400).json({ message: "Your teacher record was not found." });
      teacherId = me.id;
    }

    const filters = [range.from, range.to, teacherId];

    const byTeacher = await query(
      `SELECT t.id AS teacher_id, u.full_name AS name,
              COUNT(ta.id)::int AS marked,
              COUNT(ta.id) FILTER (WHERE ta.status = 'present')::int AS present,
              COUNT(ta.id) FILTER (WHERE ta.status = 'late')::int    AS late,
              COUNT(ta.id) FILTER (WHERE ta.status = 'absent')::int  AS absent,
              COUNT(ta.id) FILTER (WHERE ta.status = 'leave')::int   AS on_leave
         FROM teachers t
         JOIN users u ON u.id = t.user_id
         LEFT JOIN teacher_attendance ta ON ta.teacher_id = t.id AND ta.date BETWEEN $1 AND $2
        WHERE ($3::int IS NULL OR t.id = $3)
        GROUP BY t.id, u.full_name
        ORDER BY u.full_name`,
      filters
    );

    const teachers = byTeacher.map(function (r) {
      // A late teacher still came in, so late counts as attended.
      return { ...r, percentage: r.marked === 0 ? 0 : Math.round(((r.present + r.late) / r.marked) * 100) };
    });

    const byDay = await query(
      `SELECT ta.date,
              COUNT(*)::int AS marked,
              COUNT(*) FILTER (WHERE ta.status = 'present')::int AS present,
              COUNT(*) FILTER (WHERE ta.status = 'late')::int    AS late,
              COUNT(*) FILTER (WHERE ta.status = 'absent')::int  AS absent,
              COUNT(*) FILTER (WHERE ta.status = 'leave')::int   AS on_leave
         FROM teacher_attendance ta
        WHERE ta.date BETWEEN $1 AND $2
          AND ($3::int IS NULL OR ta.teacher_id = $3)
        GROUP BY ta.date
        ORDER BY ta.date`,
      filters
    );

    let present = 0, late = 0, absent = 0, onLeave = 0, marked = 0;
    for (const t of teachers) {
      present += t.present; late += t.late; absent += t.absent; onLeave += t.on_leave; marked += t.marked;
    }

    res.json({
      from: range.from,
      to: range.to,
      label: range.label,
      summary: {
        teachers: teachers.length,
        marked: marked,
        present: present,
        late: late,
        absent: absent,
        on_leave: onLeave,
        percentage: marked === 0 ? 0 : Math.round(((present + late) / marked) * 100),
      },
      by_teacher: teacherId ? [] : teachers,
      by_day: byDay,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the report." });
  }
});

module.exports = router;
