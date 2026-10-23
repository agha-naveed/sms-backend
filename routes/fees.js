const express = require("express");
const { query, queryOne } = require("../db");
const { requireLogin, allow, getStudentOfUser, parentOwnsStudent } = require("../auth");
const { notify, withTotals, monthRangeLabel, MONTHS, logAudit } = require("../helpers");

const router = express.Router();
router.use(requireLogin);

// ------------------------------------------------------------------
// POST /api/fees/generate   (admin)
// body: { month, year, due_day, class_id (optional), other_fee (optional) }
// Makes one slip per active student. Runs again safely: students who
// already have a slip for that month are skipped.
// ------------------------------------------------------------------
router.post("/generate", allow("admin"), async function (req, res) {
  try {
    const month = Number(req.body.month);
    const year = Number(req.body.year);
    const monthsCount = Number(req.body.months_count) || 1;
    const dueDay = Number(req.body.due_day) || 10;
    const otherFee = Number(req.body.other_fee) || 0;

    if (!month || month < 1 || month > 12 || !year) {
      return res.status(400).json({ message: "Choose a valid month and year." });
    }
    if (monthsCount < 1 || monthsCount > 12) {
      return res.status(400).json({ message: "One slip can cover between 1 and 12 months." });
    }

    // Months are turned into a single number so ranges are easy to compare.
    // March 2026 becomes 2026 * 12 + 3.
    const newStart = year * 12 + month;
    const newEnd = newStart + monthsCount - 1;

    const students = await query(
      `SELECT s.id, s.admission_no, c.monthly_fee, pu.id AS parent_user_id, u.full_name AS name
         FROM students s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN classes c ON c.id = s.class_id
         LEFT JOIN parents p ON p.id = s.parent_id
         LEFT JOIN users pu  ON pu.id = p.user_id
        WHERE s.status = 'active'
          AND ($1::int IS NULL OR s.class_id = $1)`,
      [req.body.class_id || null]
    );

    const dueDate = year + "-" + String(month).padStart(2, "0") + "-" + String(dueDay).padStart(2, "0");
    const label = monthRangeLabel({ month: month, year: year, months_count: monthsCount });

    let created = 0;
    let skipped = 0;

    for (const s of students) {
      // Skip the student if an existing slip already covers any of these months.
      const clash = await queryOne(
        `SELECT id FROM fee_slips
          WHERE student_id = $1
            AND (year * 12 + month) <= $2
            AND (year * 12 + month + months_count - 1) >= $3
          LIMIT 1`,
        [s.id, newEnd, newStart]
      );

      if (clash) {
        skipped = skipped + 1;
        continue;
      }

      const slipNo =
        "FEE-" + year + String(month).padStart(2, "0") +
        (monthsCount > 1 ? "-" + monthsCount + "M" : "") +
        "-" + s.admission_no;

      // A three month slip charges three months of tuition.
      const tuition = Number(s.monthly_fee || 0) * monthsCount;

      const rows = await query(
        `INSERT INTO fee_slips
           (student_id, slip_no, month, year, months_count, tuition_fee, other_fee, due_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (student_id, month, year) DO NOTHING
         RETURNING id`,
        [s.id, slipNo, month, year, monthsCount, tuition, otherFee, dueDate]
      );

      if (rows.length > 0) {
        created = created + 1;
        await notify(
          s.parent_user_id,
          "Fee slip ready",
          "The fee slip for " + s.name + " covering " + label +
            " is ready. Due date " + dueDate + ".",
          "fee"
        );
      } else {
        skipped = skipped + 1;
      }
    }

    res.json({
      message: "Fee slips generated.",
      created: created,
      already_existed: skipped,
      covers: label,
    });

    logAudit(req.user, "generated", "fee_slip", label, created + " slips created, " + skipped + " skipped");
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not generate the fee slips." });
  }
});

// ------------------------------------------------------------------
// GET /api/fees            -> role aware list of slips
//   admin:   ?status=&class_id=&month=&year=
//   student: their own
//   parent:  ?student_id= (one of their children)
// ------------------------------------------------------------------
router.get("/", async function (req, res) {
  try {
    let studentId = null;

    if (req.user.role === "student") {
      const me = await getStudentOfUser(req.user.id);
      if (!me) return res.json([]);
      studentId = me.id;
    }

    if (req.user.role === "parent") {
      studentId = Number(req.query.student_id);
      if (!studentId) return res.status(400).json({ message: "Choose a child first." });

      const ok = await parentOwnsStudent(req.user.id, studentId);
      if (!ok) return res.status(403).json({ message: "That is not your child." });
    }

    if (req.user.role === "teacher") {
      return res.status(403).json({ message: "Fees are not part of the teacher account." });
    }

    const rows = await query(
      `SELECT f.*, u.full_name AS student_name, s.admission_no,
              c.name AS class_name, sec.name AS section_name
         FROM fee_slips f
         JOIN students s ON s.id = f.student_id
         JOIN users u ON u.id = s.user_id
         LEFT JOIN classes c    ON c.id = s.class_id
         LEFT JOIN sections sec ON sec.id = s.section_id
        WHERE ($1::int IS NULL OR f.student_id = $1)
          AND ($2::int IS NULL OR s.class_id = $2)
          AND ($3::int IS NULL OR f.month = $3)
          AND ($4::int IS NULL OR f.year = $4)
          AND ($5::text IS NULL OR f.status = $5)
        ORDER BY f.year DESC, f.month DESC, u.full_name`,
      [
        studentId,
        req.query.class_id || null,
        req.query.month || null,
        req.query.year || null,
        req.query.status || null,
      ]
    );

    // late fee is worked out fresh every time, so a daily late fee stays right
    res.json(rows.map(withTotals));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the fee slips." });
  }
});

// ------------------------------------------------------------------
// GET /api/fees/slip/:id   -> everything needed to print one slip
// ------------------------------------------------------------------
router.get("/slip/:id", async function (req, res) {
  try {
    const slip = await queryOne(
      `SELECT f.*, u.full_name AS student_name, s.admission_no, s.id AS student_id,
              c.name AS class_name, sec.name AS section_name,
              pu.full_name AS parent_name
         FROM fee_slips f
         JOIN students s ON s.id = f.student_id
         JOIN users u ON u.id = s.user_id
         LEFT JOIN classes c    ON c.id = s.class_id
         LEFT JOIN sections sec ON sec.id = s.section_id
         LEFT JOIN parents p    ON p.id = s.parent_id
         LEFT JOIN users pu     ON pu.id = p.user_id
        WHERE f.id = $1`,
      [req.params.id]
    );

    if (!slip) return res.status(404).json({ message: "Fee slip not found." });

    if (req.user.role === "student") {
      const me = await getStudentOfUser(req.user.id);
      if (!me || me.id !== slip.student_id) {
        return res.status(403).json({ message: "You can only open your own slip." });
      }
    }
    if (req.user.role === "parent") {
      const ok = await parentOwnsStudent(req.user.id, slip.student_id);
      if (!ok) return res.status(403).json({ message: "That is not your child." });
    }
    if (req.user.role === "teacher") {
      return res.status(403).json({ message: "Fees are not part of the teacher account." });
    }

    const payments = await query(
      "SELECT amount, paid_on, note FROM fee_payments WHERE slip_id = $1 ORDER BY paid_on",
      [slip.id]
    );

    res.json({
      ...withTotals(slip),
      month_name: monthRangeLabel(slip),
      payments: payments,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not open the fee slip." });
  }
});

// ------------------------------------------------------------------
// POST /api/fees/:id/pay   (admin records a payment taken at the office)
// Part payments are allowed, so status can become "partial".
// ------------------------------------------------------------------
router.post("/:id/pay", allow("admin"), async function (req, res) {
  try {
    const amount = Number(req.body.amount);
    if (!amount || amount <= 0) {
      return res.status(400).json({ message: "Enter the amount received." });
    }

    const slip = await queryOne("SELECT * FROM fee_slips WHERE id = $1", [req.params.id]);
    if (!slip) return res.status(404).json({ message: "Fee slip not found." });
    if (slip.status === "paid") {
      return res.status(400).json({ message: "This slip is already fully paid." });
    }

    const full = withTotals(slip);
    if (amount > full.balance) {
      return res.status(400).json({
        message: "That is more than the balance of Rs. " + full.balance + ".",
      });
    }

    await query(
      "INSERT INTO fee_payments (slip_id, amount, received_by, note) VALUES ($1,$2,$3,$4)",
      [slip.id, amount, req.user.id, req.body.note || null]
    );

    const newPaid = Number(slip.paid_amount) + amount;
    const newStatus = newPaid >= full.total ? "paid" : "partial";

    await query(
      "UPDATE fee_slips SET paid_amount = $1, late_fee = $2, status = $3 WHERE id = $4",
      [newPaid, full.late_fee, newStatus, slip.id]
    );

    // tell the parent
    const parent = await queryOne(
      `SELECT pu.id AS parent_user_id, u.full_name AS student_name
         FROM students s
         JOIN users u ON u.id = s.user_id
         JOIN parents p ON p.id = s.parent_id
         JOIN users pu  ON pu.id = p.user_id
        WHERE s.id = $1`,
      [slip.student_id]
    );

    if (parent) {
      await notify(
        parent.parent_user_id,
        "Fee payment received",
        "Rs. " + amount + " received for " + parent.student_name + " (" +
          monthRangeLabel(slip) + "). Status: " + newStatus + ".",
        "fee"
      );
    }

    res.json({ message: "Payment recorded.", status: newStatus, paid_amount: newPaid });

    logAudit(
      req.user, "recorded", "fee_payment",
      (parent ? parent.student_name : "Slip " + slip.slip_no) + " - " + monthRangeLabel(slip),
      "Rs. " + amount + " received, now " + newStatus
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not record the payment." });
  }
});

// ------------------------------------------------------------------
// GET /api/fees/outstanding?student_id=   (admin)
// Everything this student still owes, oldest first.
// ------------------------------------------------------------------
router.get("/outstanding", allow("admin"), async function (req, res) {
  try {
    const studentId = Number(req.query.student_id);
    if (!studentId) return res.status(400).json({ message: "Choose a student." });

    const slips = await query(
      `SELECT f.*, u.full_name AS student_name, s.admission_no
         FROM fee_slips f
         JOIN students s ON s.id = f.student_id
         JOIN users u ON u.id = s.user_id
        WHERE f.student_id = $1 AND f.status <> 'paid'
        ORDER BY f.year, f.month`,
      [studentId]
    );

    const full = slips.map(withTotals).filter(function (s) { return s.balance > 0; });

    res.json({
      slips: full,
      total_due: full.reduce(function (sum, s) { return sum + s.balance; }, 0),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load what is owed." });
  }
});

// ------------------------------------------------------------------
// POST /api/fees/pay-many   (admin)
// body: { student_id, amount, note }
// A parent pays one lump sum for several months. The money is put against
// the oldest unpaid slip first, then the next, until it runs out.
// ------------------------------------------------------------------
router.post("/pay-many", allow("admin"), async function (req, res) {
  try {
    const studentId = Number(req.body.student_id);
    let left = Number(req.body.amount);

    if (!studentId) return res.status(400).json({ message: "Choose a student." });
    if (!left || left <= 0) return res.status(400).json({ message: "Enter the amount received." });

    const slips = await query(
      `SELECT * FROM fee_slips
        WHERE student_id = $1 AND status <> 'paid'
        ORDER BY year, month`,
      [studentId]
    );

    const owing = slips.map(withTotals).filter(function (s) { return s.balance > 0; });

    if (owing.length === 0) {
      return res.status(400).json({ message: "This student has nothing outstanding." });
    }

    const totalDue = owing.reduce(function (sum, s) { return sum + s.balance; }, 0);

    if (left > totalDue) {
      return res.status(400).json({
        message: "That is more than the Rs. " + totalDue + " owed in total.",
      });
    }

    const applied = [];

    for (const slip of owing) {
      if (left <= 0) break;

      const part = Math.min(left, slip.balance);

      await query(
        "INSERT INTO fee_payments (slip_id, amount, received_by, note) VALUES ($1,$2,$3,$4)",
        [slip.id, part, req.user.id, req.body.note || "Part of a combined payment"]
      );

      const newPaid = Number(slip.paid_amount) + part;
      const newStatus = newPaid >= slip.total ? "paid" : "partial";

      await query(
        "UPDATE fee_slips SET paid_amount = $1, late_fee = $2, status = $3 WHERE id = $4",
        [newPaid, slip.late_fee, newStatus, slip.id]
      );

      applied.push({ slip_no: slip.slip_no, period: slip.month_label, amount: part, status: newStatus });
      left = left - part;
    }

    const parent = await queryOne(
      `SELECT pu.id AS parent_user_id, u.full_name AS student_name
         FROM students s
         JOIN users u ON u.id = s.user_id
         JOIN parents p ON p.id = s.parent_id
         JOIN users pu  ON pu.id = p.user_id
        WHERE s.id = $1`,
      [studentId]
    );

    if (parent) {
      await notify(
        parent.parent_user_id,
        "Fee payment received",
        "Rs. " + req.body.amount + " received for " + parent.student_name +
          ", put against " + applied.length + " slip" + (applied.length === 1 ? "" : "s") + ".",
        "fee"
      );
    }

    res.json({
      message: "Payment recorded against " + applied.length + " slip" +
        (applied.length === 1 ? "" : "s") + ".",
      applied: applied,
    });

    logAudit(
      req.user, "recorded", "fee_payment",
      (parent ? parent.student_name : "Student #" + studentId),
      "Rs. " + req.body.amount + " across " + applied.length + " slips"
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not record the payment." });
  }
});

// ------------------------------------------------------------------
// GET /api/fees/summary   (admin dashboard numbers)
// ------------------------------------------------------------------
router.get("/summary", allow("admin"), async function (req, res) {
  try {
    const slips = await query("SELECT * FROM fee_slips");
    const full = slips.map(withTotals);

    let collected = 0;
    let pending = 0;
    let overdue = 0;

    for (const s of full) {
      collected += s.paid_amount;
      pending += s.balance;
      if (s.is_overdue) overdue = overdue + 1;
    }

    res.json({
      total_slips: full.length,
      collected: collected,
      pending: pending,
      overdue_slips: overdue,
      paid_slips: full.filter(function (s) { return s.status === "paid"; }).length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the fee summary." });
  }
});

module.exports = router;
