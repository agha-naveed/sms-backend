const express = require("express");
const { query, queryOne } = require("../db");
const {
  requireLogin,
  allow,
  teacherOwnsSection,
  teacherIsClassTeacher,
  parentOwnsStudent,
  getStudentOfUser,
} = require("../auth");
const {
  notify, MONTHS, WEEKLY_HOLIDAY, DAY_NAMES,
  getAttendanceWindow, isWithinWindow, friendlyTime,
  resolveRange, todayText, asDateText, logAudit,
} = require("../helpers");

const router = express.Router();
router.use(requireLogin);

function today() {
  return todayText();
}

function asDate(value) {
  return asDateText(value);
}

// ------------------------------------------------------------------
// GET /api/attendance/roster?class_id=1&section_id=2&date=2026-09-06
// The list a teacher fills in. If attendance was already marked for
// that day, the saved answers come back with it.
// ------------------------------------------------------------------
router.get("/roster", allow("teacher", "admin"), async function (req, res) {
  try {
    const { class_id, section_id } = req.query;
    const date = req.query.date || today();

    if (!class_id || !section_id) {
      return res.status(400).json({ message: "Choose a class and a section." });
    }

    if (req.user.role === "teacher") {
      const ok = await teacherIsClassTeacher(req.user.id, class_id, section_id);
      if (!ok) {
        return res.status(403).json({
          message: "Only the class teacher of this section can mark its attendance. Ask the admin if this should be you.",
        });
      }
    }

    const students = await query(
      `SELECT s.id, s.admission_no, u.full_name AS name,
              a.status, a.id AS attendance_id
         FROM students s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN attendance a
                ON a.student_id = s.id AND a.date = $3
        WHERE s.class_id = $1 AND s.section_id = $2 AND s.status = 'active'
        ORDER BY u.full_name`,
      [class_id, section_id, date]
    );

    const isHoliday =
      WEEKLY_HOLIDAY >= 0 && new Date(date + "T12:00:00").getDay() === WEEKLY_HOLIDAY;

    const window = await getAttendanceWindow();

    res.json({
      date: date,
      is_holiday: isHoliday,
      holiday_name: isHoliday ? DAY_NAMES[WEEKLY_HOLIDAY] : null,
      already_marked: students.some(function (s) { return s.attendance_id !== null; }),
      students: students,
      attendance_window: window,
      // The admin can always act; a teacher only inside the window.
      within_window: req.user.role === "admin" || isWithinWindow(window),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the student list." });
  }
});

// ------------------------------------------------------------------
// POST /api/attendance/mark
// body: { class_id, section_id, date, records: [{ student_id, status }] }
// Saves the whole class at once, then sends one notification to the
// parent of every absent student.
// ------------------------------------------------------------------
router.post("/mark", allow("teacher", "admin"), async function (req, res) {
  try {
    const { class_id, section_id, records } = req.body;
    const date = req.body.date || today();

    if (!class_id || !section_id || !Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ message: "Nothing to save." });
    }

    if (req.user.role === "teacher") {
      const ok = await teacherIsClassTeacher(req.user.id, class_id, section_id);
      if (!ok) {
        return res.status(403).json({
          message: "Only the class teacher of this section can mark its attendance. Ask the admin if this should be you.",
        });
      }

      // The class teacher can only submit inside the daily window. The
      // admin is exempt, so a mistake can still be fixed outside it.
      const window = await getAttendanceWindow();
      if (!isWithinWindow(window)) {
        return res.status(400).json({
          message:
            "Attendance can only be submitted between " + friendlyTime(window.start) +
            " and " + friendlyTime(window.end) + ". Ask the admin if you missed it today.",
        });
      }
    }

    // The school is closed on the weekly holiday, so no attendance that day.
    if (WEEKLY_HOLIDAY >= 0 && new Date(date + "T12:00:00").getDay() === WEEKLY_HOLIDAY) {
      return res.status(400).json({
        message: "The school is closed on " + DAY_NAMES[WEEKLY_HOLIDAY] +
          ", so attendance cannot be marked for that date.",
      });
    }

    // Every student must have an answer before submitting.
    const missing = records.filter(function (r) {
      return !["present", "absent", "leave"].includes(r.status);
    });
    if (missing.length > 0) {
      return res.status(400).json({ message: "Mark every student before you submit." });
    }

    // A teacher submits once per day. Only an admin can overwrite.
    const existing = await queryOne(
      `SELECT id FROM attendance
        WHERE class_id = $1 AND section_id = $2 AND date = $3 LIMIT 1`,
      [class_id, section_id, date]
    );
    if (existing && req.user.role === "teacher") {
      return res.status(400).json({
        message: "Attendance for this date is already submitted. Ask the admin to change it.",
      });
    }

    // Save every row. ON CONFLICT lets the admin correct a mistake.
    for (const r of records) {
      await query(
        `INSERT INTO attendance (student_id, class_id, section_id, date, status, marked_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (student_id, date)
         DO UPDATE SET status = EXCLUDED.status, marked_by = EXCLUDED.marked_by`,
        [r.student_id, class_id, section_id, date, r.status, req.user.id]
      );
    }

    // --- notify the parents of absent students ---
    const absentIds = records
      .filter(function (r) { return r.status === "absent"; })
      .map(function (r) { return r.student_id; });

    let notified = 0;

    if (absentIds.length > 0) {
      const absentees = await query(
        `SELECT s.id, u.full_name AS student_name,
                pu.id AS parent_user_id,
                c.name AS class_name, sec.name AS section_name
           FROM students s
           JOIN users u ON u.id = s.user_id
           LEFT JOIN parents p ON p.id = s.parent_id
           LEFT JOIN users pu  ON pu.id = p.user_id
           LEFT JOIN classes c    ON c.id = s.class_id
           LEFT JOIN sections sec ON sec.id = s.section_id
          WHERE s.id = ANY($1::int[])`,
        [absentIds]
      );

      const nice = new Date(date).toDateString();

      for (const a of absentees) {
        if (a.parent_user_id) {
          await notify(
            a.parent_user_id,
            a.student_name + " was absent today",
            a.student_name +
              " (" + a.class_name + " - " + a.section_name + ") was marked absent on " +
              nice + ". If this is wrong, please contact the school office.",
            "attendance"
          );
          notified = notified + 1;
        }
      }
    }

    res.json({
      message: "Attendance submitted.",
      total: records.length,
      absent: absentIds.length,
      parents_notified: notified,
    });

    const place = await queryOne(
      `SELECT c.name AS class_name, sec.name AS section_name
         FROM classes c, sections sec
        WHERE c.id = $1 AND sec.id = $2`,
      [class_id, section_id]
    );
    if (place) {
      logAudit(
        req.user, "marked", "attendance",
        place.class_name + " - Section " + place.section_name + " on " + date,
        records.length + " students, " + absentIds.length + " absent"
      );
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not save the attendance." });
  }
});

// ------------------------------------------------------------------
// GET /api/attendance/student/:id?month=9&year=2026
// A student's own record, or a parent looking at their child.
// ------------------------------------------------------------------
router.get("/student/:id", async function (req, res) {
  try {
    const id = Number(req.params.id);

    if (req.user.role === "student") {
      const me = await getStudentOfUser(req.user.id);
      if (!me || me.id !== id) {
        return res.status(403).json({ message: "You can only view your own attendance." });
      }
    }
    if (req.user.role === "parent") {
      const ok = await parentOwnsStudent(req.user.id, id);
      if (!ok) return res.status(403).json({ message: "That is not your child." });
    }

    const now = new Date();
    const month = Number(req.query.month) || now.getMonth() + 1;
    const year = Number(req.query.year) || now.getFullYear();

    const records = await query(
      `SELECT date, status
         FROM attendance
        WHERE student_id = $1
          AND EXTRACT(MONTH FROM date) = $2
          AND EXTRACT(YEAR FROM date) = $3
        ORDER BY date DESC`,
      [id, month, year]
    );

    const counts = { present: 0, absent: 0, leave: 0 };
    for (const r of records) counts[r.status] = counts[r.status] + 1;

    const marked = records.length;
    const percentage = marked === 0 ? 0 : Math.round((counts.present / marked) * 100);

    res.json({
      month: month,
      month_name: MONTHS[month - 1],
      year: year,
      records: records,
      summary: { ...counts, total_days: marked, percentage: percentage },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load attendance." });
  }
});

// ------------------------------------------------------------------
// GET /api/attendance/report
//   period=day|week|month  (or send from= and to= yourself)
//   date=            the day inside the period you want
//   class_id=  section_id=  student_id=   optional filters
//
// One endpoint for all four roles. Who is allowed to see what:
//   admin    everything
//   teacher  only sections assigned to them
//   student  only themselves
//   parent   only their own children
// ------------------------------------------------------------------
router.get("/report", async function (req, res) {
  try {
    const range = resolveRange(req.query.period, req.query.date, req.query.from, req.query.to);

    let classId = req.query.class_id || null;
    let sectionId = req.query.section_id || null;
    let studentId = req.query.student_id || null;

    // ---- work out what this person is allowed to ask for ----
    if (req.user.role === "student") {
      const me = await getStudentOfUser(req.user.id);
      if (!me) return res.status(404).json({ message: "Student record not found." });
      studentId = me.id;
      classId = null;
      sectionId = null;
    }

    if (req.user.role === "parent") {
      if (!studentId) return res.status(400).json({ message: "Choose a child first." });
      const ok = await parentOwnsStudent(req.user.id, studentId);
      if (!ok) return res.status(403).json({ message: "That is not your child." });
      classId = null;
      sectionId = null;
    }

    if (req.user.role === "teacher") {
      if (!classId || !sectionId) {
        return res.status(400).json({ message: "Choose one of your classes and sections." });
      }
      const ok = await teacherOwnsSection(req.user.id, classId, sectionId);
      if (!ok) return res.status(403).json({ message: "You are not assigned to this section." });
    }

    const filters = [range.from, range.to, classId, sectionId, studentId];

    // ---- one row per student ----
    const byStudent = await query(
      `SELECT s.id AS student_id, u.full_name AS name, s.admission_no,
              c.name AS class_name, sec.name AS section_name,
              COUNT(a.id)::int AS marked,
              COUNT(a.id) FILTER (WHERE a.status = 'present')::int AS present,
              COUNT(a.id) FILTER (WHERE a.status = 'absent')::int  AS absent,
              COUNT(a.id) FILTER (WHERE a.status = 'leave')::int   AS on_leave
         FROM students s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN classes c    ON c.id = s.class_id
         LEFT JOIN sections sec ON sec.id = s.section_id
         LEFT JOIN attendance a
                ON a.student_id = s.id AND a.date BETWEEN $1 AND $2
        WHERE s.status = 'active'
          AND ($3::int IS NULL OR s.class_id = $3)
          AND ($4::int IS NULL OR s.section_id = $4)
          AND ($5::int IS NULL OR s.id = $5)
        GROUP BY s.id, u.full_name, s.admission_no, c.name, sec.name
        ORDER BY c.name, sec.name, u.full_name`,
      filters
    );

    const students = byStudent.map(function (r) {
      return {
        ...r,
        percentage: r.marked === 0 ? 0 : Math.round((r.present / r.marked) * 100),
      };
    });

    // ---- one row per day ----
    const byDay = await query(
      `SELECT a.date,
              COUNT(*)::int AS marked,
              COUNT(*) FILTER (WHERE a.status = 'present')::int AS present,
              COUNT(*) FILTER (WHERE a.status = 'absent')::int  AS absent,
              COUNT(*) FILTER (WHERE a.status = 'leave')::int   AS on_leave
         FROM attendance a
         JOIN students s ON s.id = a.student_id
        WHERE a.date BETWEEN $1 AND $2
          AND ($3::int IS NULL OR s.class_id = $3)
          AND ($4::int IS NULL OR s.section_id = $4)
          AND ($5::int IS NULL OR s.id = $5)
        GROUP BY a.date
        ORDER BY a.date`,
      filters
    );

    // ---- one row per class and section (admin overview) ----
    let bySection = [];

    if (req.user.role === "admin" && !studentId) {
      bySection = await query(
        `SELECT c.name AS class_name, sec.name AS section_name,
                COUNT(DISTINCT s.id)::int AS students,
                COUNT(a.id)::int AS marked,
                COUNT(a.id) FILTER (WHERE a.status = 'present')::int AS present,
                COUNT(a.id) FILTER (WHERE a.status = 'absent')::int  AS absent,
                COUNT(a.id) FILTER (WHERE a.status = 'leave')::int   AS on_leave
           FROM students s
           LEFT JOIN classes c    ON c.id = s.class_id
           LEFT JOIN sections sec ON sec.id = s.section_id
           LEFT JOIN attendance a
                  ON a.student_id = s.id AND a.date BETWEEN $1 AND $2
          WHERE s.status = 'active'
            AND ($3::int IS NULL OR s.class_id = $3)
            AND ($4::int IS NULL OR s.section_id = $4)
          GROUP BY c.name, sec.name
          ORDER BY c.name, sec.name`,
        [range.from, range.to, classId, sectionId]
      );

      bySection = bySection.map(function (r) {
        return {
          ...r,
          percentage: r.marked === 0 ? 0 : Math.round((r.present / r.marked) * 100),
        };
      });
    }

    // ---- totals ----
    let present = 0;
    let absent = 0;
    let onLeave = 0;
    let marked = 0;

    for (const s of students) {
      present += s.present;
      absent += s.absent;
      onLeave += s.on_leave;
      marked += s.marked;
    }

    res.json({
      from: range.from,
      to: range.to,
      label: range.label,
      summary: {
        students: students.length,
        school_days: byDay.length,
        marked: marked,
        present: present,
        absent: absent,
        on_leave: onLeave,
        percentage: marked === 0 ? 0 : Math.round((present / marked) * 100),
      },
      by_day: byDay,
      by_student: students,
      by_section: bySection,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not build the attendance report." });
  }
});

// ------------------------------------------------------------------
// GET /api/attendance/daily?date=  -> admin view of one day
// ------------------------------------------------------------------
router.get("/daily", allow("admin"), async function (req, res) {
  try {
    const date = req.query.date || today();
    const rows = await query(
      `SELECT c.name AS class_name, sec.name AS section_name,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE a.status = 'present')::int AS present,
              COUNT(*) FILTER (WHERE a.status = 'absent')::int  AS absent,
              COUNT(*) FILTER (WHERE a.status = 'leave')::int   AS on_leave
         FROM attendance a
         JOIN classes c    ON c.id = a.class_id
         JOIN sections sec ON sec.id = a.section_id
        WHERE a.date = $1
        GROUP BY c.name, sec.name
        ORDER BY c.name, sec.name`,
      [date]
    );
    res.json({ date: date, rows: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the attendance report." });
  }
});

module.exports = router;
