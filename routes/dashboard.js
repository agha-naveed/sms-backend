const express = require("express");
const { query, queryOne } = require("../db");
const { requireLogin, getStudentOfUser, getTeacherOfUser, getParentOfUser } = require("../auth");
const { withTotals, MONTHS } = require("../helpers");

const router = express.Router();
router.use(requireLogin);

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Attendance for the last 14 days as one point per school day:
// the share of marked students who were present.
async function attendanceTrend(sectionPairs) {
  const rows = await query(
    `SELECT TO_CHAR(a.date, 'YYYY-MM-DD') AS date,
            COUNT(*)::int AS marked,
            COUNT(*) FILTER (WHERE a.status = 'present')::int AS present,
            COUNT(*) FILTER (WHERE a.status = 'absent')::int  AS absent
       FROM attendance a
      WHERE a.date >= CURRENT_DATE - 13
        AND ($1::text IS NULL OR (a.class_id || '-' || a.section_id) = ANY(string_to_array($1, ',')))
      GROUP BY a.date
      ORDER BY a.date`,
    [sectionPairs]
  );

  return rows.map(function (r) {
    return {
      date: r.date, marked: r.marked, present: r.present, absent: r.absent,
      percentage: r.marked === 0 ? 0 : Math.round((r.present / r.marked) * 100),
    };
  });
}

// GET /api/dashboard  -> different numbers depending on the role
router.get("/", async function (req, res) {
  try {
    const role = req.user.role;

    // ---------------- ADMIN ----------------
    if (role === "admin") {
      const counts = await queryOne(
        `SELECT
           (SELECT COUNT(*)::int FROM students WHERE status = 'active') AS students,
           (SELECT COUNT(*)::int FROM teachers)                          AS teachers,
           (SELECT COUNT(*)::int FROM parents)                           AS parents,
           (SELECT COUNT(*)::int FROM classes)                           AS classes,
           (SELECT COUNT(*)::int FROM admissions WHERE status = 'pending') AS pending_admissions`
      );

      const attendance = await queryOne(
        `SELECT
           COUNT(*)::int AS marked,
           COUNT(*) FILTER (WHERE status = 'present')::int AS present,
           COUNT(*) FILTER (WHERE status = 'absent')::int  AS absent
         FROM attendance WHERE date = $1`,
        [today()]
      );

      const slips = await query("SELECT * FROM fee_slips");
      const full = slips.map(withTotals);
      let collected = 0;
      let pending = 0;
      for (const s of full) {
        collected += s.paid_amount;
        pending += s.balance;
      }

      const recentAdmissions = await query(
        `SELECT a.id, a.student_name, a.status, a.created_at, c.name AS applying_class
           FROM admissions a
           LEFT JOIN classes c ON c.id = a.applying_class_id
          ORDER BY a.created_at DESC LIMIT 5`
      );

      // ---- numbers for the dashboard graphs ----
      const studentsByClass = await query(
        `SELECT c.name, COUNT(s.id)::int AS count
           FROM classes c
           LEFT JOIN students s ON s.class_id = c.id AND s.status = 'active'
          GROUP BY c.id, c.name
          ORDER BY c.id`
      );

      // Fees received in each of the last 6 months (months with nothing show 0).
      const paid = await query(
        `SELECT TO_CHAR(paid_on, 'YYYY-MM') AS ym, SUM(amount)::float AS total
           FROM fee_payments
          WHERE paid_on >= date_trunc('month', CURRENT_DATE) - INTERVAL '5 months'
          GROUP BY 1`
      );
      const paidByMonth = {};
      paid.forEach(function (p) { paidByMonth[p.ym] = p.total; });

      const feesByMonth = [];
      const now = new Date();
      for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
        feesByMonth.push({ label: MONTHS[d.getMonth()].slice(0, 3), value: paidByMonth[key] || 0 });
      }

      const admissionsByStatus = await query(
        "SELECT status, COUNT(*)::int AS count FROM admissions GROUP BY status ORDER BY status"
      );

      return res.json({
        role: role,
        counts: counts,
        attendance_today: attendance,
        fees: { collected: collected, pending: pending },
        recent_admissions: recentAdmissions,
        charts: {
          attendance_trend: await attendanceTrend(null),
          students_by_class: studentsByClass,
          fees_by_month: feesByMonth,
          admissions_by_status: admissionsByStatus,
        },
      });
    }

    // ---------------- TEACHER ----------------
    if (role === "teacher") {
      const teacher = await getTeacherOfUser(req.user.id);
      if (!teacher) return res.json({ role: role, classes: [], counts: {} });

      const classes = await query(
        `SELECT x.class_id, x.section_id, c.name AS class_name, sec.name AS section_name,
                (SELECT COUNT(*)::int FROM students s
                  WHERE s.class_id = x.class_id AND s.section_id = x.section_id
                    AND s.status = 'active') AS student_count,
                EXISTS (SELECT 1 FROM attendance a
                         WHERE a.class_id = x.class_id AND a.section_id = x.section_id
                           AND a.date = $2) AS attendance_done,
                (sec.class_teacher_id = $1) AS is_class_teacher
           FROM (
             SELECT class_id, section_id FROM teacher_classes WHERE teacher_id = $1
             UNION
             SELECT class_id, id AS section_id FROM sections WHERE class_teacher_id = $1
           ) x
           JOIN classes c    ON c.id = x.class_id
           JOIN sections sec ON sec.id = x.section_id
          ORDER BY c.name, sec.name`,
        [teacher.id, today()]
      );

      const assignments = await queryOne(
        "SELECT COUNT(*)::int AS total FROM assignments WHERE teacher_id = $1",
        [teacher.id]
      );

      return res.json({
        role: role,
        classes: classes,
        counts: {
          sections: classes.length,
          students: classes.reduce(function (sum, c) { return sum + c.student_count; }, 0),
          assignments: assignments.total,
          pending_attendance: classes.filter(function (c) { return !c.attendance_done; }).length,
        },
        charts: {
          attendance_trend: await attendanceTrend(
            classes.length === 0 ? "none" : classes.map(function (c) { return c.class_id + "-" + c.section_id; }).join(",")
          ),
        },
      });
    }

    // ---------------- STUDENT ----------------
    if (role === "student") {
      const me = await getStudentOfUser(req.user.id);
      if (!me) return res.json({ role: role });

      const now = new Date();

      const attendance = await queryOne(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'present')::int AS present
           FROM attendance
          WHERE student_id = $1
            AND EXTRACT(MONTH FROM date) = $2 AND EXTRACT(YEAR FROM date) = $3`,
        [me.id, now.getMonth() + 1, now.getFullYear()]
      );

      const assignments = await queryOne(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (
                  WHERE NOT EXISTS (SELECT 1 FROM submissions sm
                                     WHERE sm.assignment_id = a.id AND sm.student_id = $3)
                )::int AS not_submitted
           FROM assignments a
          WHERE a.class_id = $1 AND a.section_id = $2`,
        [me.class_id, me.section_id, me.id]
      );

      const slips = await query("SELECT * FROM fee_slips WHERE student_id = $1", [me.id]);
      const unpaid = slips.map(withTotals).filter(function (s) { return s.balance > 0; });

      return res.json({
        role: role,
        student_id: me.id,
        attendance: {
          ...attendance,
          percentage: attendance.total === 0
            ? 0
            : Math.round((attendance.present / attendance.total) * 100),
        },
        assignments: assignments,
        fees: {
          unpaid_slips: unpaid.length,
          due_amount: unpaid.reduce(function (sum, s) { return sum + s.balance; }, 0),
        },
      });
    }

    // ---------------- PARENT ----------------
    if (role === "parent") {
      const parent = await getParentOfUser(req.user.id);
      if (!parent) return res.json({ role: role, children: [] });

      const children = await query(
        `SELECT s.id, u.full_name AS name, s.admission_no,
                c.name AS class_name, sec.name AS section_name
           FROM students s
           JOIN users u ON u.id = s.user_id
           LEFT JOIN classes c    ON c.id = s.class_id
           LEFT JOIN sections sec ON sec.id = s.section_id
          WHERE s.parent_id = $1
          ORDER BY u.full_name`,
        [parent.id]
      );

      const now = new Date();

      for (const child of children) {
        const att = await queryOne(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE status = 'present')::int AS present,
                  COUNT(*) FILTER (WHERE status = 'absent')::int  AS absent
             FROM attendance
            WHERE student_id = $1
              AND EXTRACT(MONTH FROM date) = $2 AND EXTRACT(YEAR FROM date) = $3`,
          [child.id, now.getMonth() + 1, now.getFullYear()]
        );

        child.attendance = {
          ...att,
          percentage: att.total === 0 ? 0 : Math.round((att.present / att.total) * 100),
        };

        const slips = await query("SELECT * FROM fee_slips WHERE student_id = $1", [child.id]);
        const unpaid = slips.map(withTotals).filter(function (s) { return s.balance > 0; });

        child.fees = {
          unpaid_slips: unpaid.length,
          due_amount: unpaid.reduce(function (sum, s) { return sum + s.balance; }, 0),
        };

        const todayRow = await queryOne(
          "SELECT status FROM attendance WHERE student_id = $1 AND date = $2",
          [child.id, today()]
        );
        child.today_status = todayRow ? todayRow.status : "not marked";
      }

      const unread = await queryOne(
        "SELECT COUNT(*)::int AS unread FROM notifications WHERE user_id = $1 AND is_read = FALSE",
        [req.user.id]
      );

      return res.json({ role: role, children: children, unread: unread.unread });
    }

    res.json({ role: role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the dashboard." });
  }
});

module.exports = router;
