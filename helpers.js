// Small shared functions used by more than one route file.
require("dotenv").config();
const path = require("path");
const multer = require("multer");
const { query } = require("./db");

// ---- file uploads ----------------------------------------------
// Files are saved in server/uploads with a unique name so two people
// uploading "homework.pdf" do not overwrite each other.
const storage = multer.diskStorage({
  destination: function (req, file, done) {
    done(null, path.join(__dirname, "uploads"));
  },
  filename: function (req, file, done) {
    const stamp = Date.now() + "-" + Math.round(Math.random() * 100000);
    done(null, stamp + path.extname(file.originalname).toLowerCase());
  },
});

const ALLOWED = [".jpg", ".jpeg", ".png", ".pdf", ".doc", ".docx"];

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: function (req, file, done) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED.includes(ext)) {
      done(null, true);
    } else {
      done(new Error("Only JPG, PNG, PDF and Word files are allowed."));
    }
  },
});

// ---- phone numbers and CNIC ------------------------------------
// Stored in one shape so searching and printing are predictable:
//   phone  +923001234567
//   CNIC   35202-1234567-1

// Turns anything the user types into +92XXXXXXXXXX, or null if it is not
// a usable Pakistani mobile number.
function cleanPhone(input) {
  if (!input) return null;

  let digits = String(input).replace(/\D/g, "");

  if (digits.startsWith("0092")) digits = digits.slice(4);
  else if (digits.startsWith("92")) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = digits.slice(1);

  // What is left must be 10 digits starting with 3, e.g. 3001234567
  if (!/^3\d{9}$/.test(digits)) return null;

  return "+92" + digits;
}

// Turns anything the user types into 35202-1234567-1, or null if it is
// not 13 digits.
function cleanCnic(input) {
  if (!input) return null;

  const digits = String(input).replace(/\D/g, "");
  if (digits.length !== 13) return null;

  return digits.slice(0, 5) + "-" + digits.slice(5, 12) + "-" + digits.slice(12);
}

// ---- new accounts ----------------------------------------------
// Every account the school creates starts on this password.
const DEFAULT_PASSWORD = "12345";

// A random, easy-to-read temporary password for admin-assisted resets.
// Ambiguous characters (0/O, 1/l/I) are left out so it's easy to read
// aloud or copy onto a slip of paper without confusion.
function randomPassword() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// Builds the next registration number: 2026-0001, 2026-0002, ...
// Used by the admission approval and by the "add a student" form, so both
// produce numbers in the same series.
async function nextAdmissionNo() {
  const { queryOne } = require("./db");
  const year = new Date().getFullYear();

  const row = await queryOne(
    "SELECT COUNT(*)::int AS total FROM students WHERE admission_no LIKE $1",
    [year + "-%"]
  );

  return year + "-" + String(row.total + 1).padStart(4, "0");
}

// The login address that goes with a registration number.
function schoolEmail(admissionNo) {
  return admissionNo + "@school.com";
}

// Finds a parent account already using this CNIC or mobile number.
// Returns null when the details are free to use.
// Pass ignoreParentId when editing, so a parent does not clash with itself.
async function parentClash(cnic, phone, ignoreParentId) {
  const { queryOne } = require("./db");

  if (!cnic && !phone) return null;

  const row = await queryOne(
    `SELECT p.id, u.full_name AS name, u.email, u.phone, p.cnic
       FROM parents p
       JOIN users u ON u.id = p.user_id
      WHERE ($3::int IS NULL OR p.id <> $3)
        AND (($1::text IS NOT NULL AND p.cnic = $1)
          OR ($2::text IS NOT NULL AND u.phone = $2))
      LIMIT 1`,
    [cnic || null, phone || null, ignoreParentId || null]
  );

  if (!row) return null;

  return {
    ...row,
    field: cnic && row.cnic === cnic ? "CNIC" : "mobile number",
  };
}

// Who already signs in with this email, whatever their role. One email
// belongs to one person here: a parent cannot reuse a teacher's address.
async function emailOwner(email, ignoreUserId) {
  const { queryOne } = require("./db");
  if (!email) return null;

  return await queryOne(
    `SELECT id, full_name, role FROM users
      WHERE LOWER(email) = LOWER($1)
        AND ($2::int IS NULL OR id <> $2)`,
    [email, ignoreUserId || null]
  );
}

// Staff addresses always end in @school.com. The admin types the part in
// front and this builds the rest, so no outside address gets in by mistake.
function staffEmail(input) {
  const local = String(input || "")
    .trim()
    .toLowerCase()
    .split("@")[0]
    .replace(/[^a-z0-9._-]/g, "");

  if (local.length < 3) return null;
  return local + "@school.com";
}

// The day of the week the school is closed. 0 is Sunday.
const WEEKLY_HOLIDAY = Number(
  process.env.WEEKLY_HOLIDAY === undefined ? 0 : process.env.WEEKLY_HOLIDAY
);

const DAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

// Compares the three things that identify a parent: CNIC, name and email.
// A CNIC belongs to one person, so if it is already here the name and the
// email must match it too. Anything else is a different person using a CNIC
// that is not theirs.
//
// Returns one of:
//   { status: "free" }      nobody has this CNIC yet
//   { status: "match" }     same person, so a second child can be added
//   { status: "conflict" }  the CNIC is here but the details do not agree
async function parentIdentity(cnic, name, email) {
  const { queryOne } = require("./db");

  if (!cnic) return { status: "free" };

  const owner = await queryOne(
    `SELECT p.id, u.id AS user_id, u.full_name, u.email
       FROM parents p
       JOIN users u ON u.id = p.user_id
      WHERE p.cnic = $1`,
    [cnic]
  );

  if (!owner) return { status: "free" };

  const tidy = function (v) {
    return String(v || "").trim().toLowerCase().replace(/\s+/g, " ");
  };

  const sameName = tidy(owner.full_name) === tidy(name);
  const sameEmail = tidy(owner.email) === tidy(email);

  if (sameName && sameEmail) {
    return { status: "match", parent: owner };
  }

  const differs = [];
  if (!sameName) differs.push("name");
  if (!sameEmail) differs.push("email");

  return { status: "conflict", differs: differs, parent: owner };
}

// A mobile number belongs to one person. The same person may hold two
// accounts here - a teacher who also has a child at the school - and then the
// number is shared, but only when the name matches.
//
//   { status: "free" }      nobody uses this number
//   { status: "match" }     same person, different kind of account: allowed
//   { status: "conflict" }  somebody else already uses it
//   { status: "duplicate" } that person already has an account of this kind
//
// Students are left out: brothers and sisters normally give their parent's
// number, and that is fine.
async function phoneIdentity(phone, name, role, ignoreUserId) {
  const { query } = require("./db");

  if (!phone) return { status: "free" };

  const rows = await query(
    `SELECT id, full_name, role, email FROM users
      WHERE phone = $1
        AND role <> 'student'
        AND ($2::int IS NULL OR id <> $2)`,
    [phone, ignoreUserId || null]
  );

  if (rows.length === 0) return { status: "free" };

  const tidy = function (v) {
    return String(v || "").trim().toLowerCase().replace(/\s+/g, " ");
  };

  const somebodyElse = rows.find(function (r) {
    return tidy(r.full_name) !== tidy(name);
  });

  if (somebodyElse) return { status: "conflict", other: somebodyElse };

  const sameKind = rows.find(function (r) { return r.role === role; });
  if (sameKind) return { status: "duplicate", other: sameKind };

  return { status: "match", other: rows[0] };
}

// Turns a phoneIdentity result into a sentence, or null when it is fine.
function phoneProblem(result, phone) {
  if (result.status === "conflict") {
    return phone + " is already used by " + result.other.full_name +
      " (" + result.other.role + "). A mobile number belongs to one person.";
  }
  if (result.status === "duplicate") {
    return result.other.full_name + " already has a " + result.other.role +
      " account with this number (" + result.other.email + ").";
  }
  return null;
}

// ---- date ranges for attendance-style reports ---------------------
// period is "day", "week" or "month". Anything else means the caller sent
// their own from and to dates. Shared by student and teacher attendance.
function todayText() {
  return new Date().toISOString().slice(0, 10);
}

function asDateText(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function resolveRange(period, dateText, fromText, toText) {
  if (fromText && toText) {
    return { from: fromText, to: toText, label: fromText + " to " + toText };
  }

  const base = dateText ? new Date(dateText) : new Date();
  base.setHours(12, 0, 0, 0); // midday avoids timezone surprises

  if (period === "day") {
    const d = asDateText(base);
    return { from: d, to: d, label: base.toDateString() };
  }

  if (period === "week") {
    const day = base.getDay(); // 0 = Sunday
    const backToMonday = day === 0 ? 6 : day - 1;

    const start = new Date(base);
    start.setDate(base.getDate() - backToMonday);

    const end = new Date(start);
    end.setDate(start.getDate() + 6);

    return {
      from: asDateText(start),
      to: asDateText(end),
      label: "Week of " + start.toDateString(),
    };
  }

  // month is the default
  const start = new Date(base.getFullYear(), base.getMonth(), 1, 12);
  const end = new Date(base.getFullYear(), base.getMonth() + 1, 0, 12);

  return {
    from: asDateText(start),
    to: asDateText(end),
    label: MONTHS[base.getMonth()] + " " + base.getFullYear(),
  };
}

// ---- school settings ---------------------------------------------
// One row holding the daily window attendance can be marked in. Read on
// every attendance submission and editable by the admin.
async function getAttendanceWindow() {
  const { queryOne } = require("./db");
  const row = await queryOne("SELECT attendance_start, attendance_end FROM school_settings ORDER BY id LIMIT 1");
  return {
    start: row ? row.attendance_start.slice(0, 5) : "07:00",
    end: row ? row.attendance_end.slice(0, 5) : "11:00",
  };
}

// "HH:MM" -> minutes since midnight, for comparing against the clock.
function minutesOf(hhmm) {
  const parts = String(hhmm).split(":");
  return Number(parts[0]) * 60 + Number(parts[1] || 0);
}

// Is right now inside the attendance window? Used to decide whether a
// teacher may submit attendance at this moment.
function isWithinWindow(window) {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return nowMinutes >= minutesOf(window.start) && nowMinutes <= minutesOf(window.end);
}

// "07:00" -> "7:00 AM", for messages shown to the teacher.
function friendlyTime(hhmm) {
  const parts = String(hhmm).split(":");
  let hour = Number(parts[0]);
  const minute = parts[1] || "00";
  const suffix = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return hour + ":" + minute + " " + suffix;
}

// ---- audit log ---------------------------------------------------
// A read-only trail for the admin: who did what, and when. Call this from
// a route right after a change succeeds. Never let a logging failure break
// the actual request, so problems here are swallowed and printed, not
// thrown.
async function logAudit(user, action, entity, label, details) {
  // Mark this request as already recorded, so the safety-net in
  // auditTrail.js does not add a second, vaguer entry for the same thing.
  if (user && typeof user === "object") user._audited = true;

  try {
    await query(
      `INSERT INTO audit_logs (user_id, user_name, user_role, action, entity, label, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        user ? user.id : null,
        user ? user.name : null,
        user ? user.role : null,
        action,
        entity,
        label || null,
        details || null,
      ]
    );
  } catch (err) {
    console.error("Could not write audit log:", err.message);
  }
}

// ---- notifications ---------------------------------------------
// Saves one notification for one user. Used for absences, fees, etc.
async function notify(userId, title, body, type) {
  if (!userId) return;
  await query(
    `INSERT INTO notifications (user_id, title, body, type)
     VALUES ($1, $2, $3, $4)`,
    [userId, title, body || "", type || "general"]
  );
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// ---- fee maths -------------------------------------------------
// Works out the late fee for one slip based on today's date.
// Called every time slips are read, so a daily late fee is always current.
function calcLateFee(slip) {
  if (slip.status === "paid") return Number(slip.late_fee);

  const due = new Date(slip.due_date);
  const today = new Date();
  due.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);

  if (today <= due) return 0;

  const type = process.env.LATE_FEE_TYPE || "daily";
  const amount = Number(process.env.LATE_FEE_AMOUNT || 0);
  const cap = Number(process.env.LATE_FEE_MAX || 0);

  if (type === "daily") {
    const oneDay = 24 * 60 * 60 * 1000;
    const daysLate = Math.round((today - due) / oneDay);
    const charge = daysLate * amount;
    // A cap stops an old unpaid slip growing forever. 0 means no cap.
    return cap > 0 && charge > cap ? cap : charge;
  }
  return amount;
}

// How many days past the due date a slip is. 0 if it is not late yet.
function daysOverdue(slip) {
  const due = new Date(slip.due_date);
  const today = new Date();
  due.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  if (today <= due) return 0;
  return Math.round((today - due) / (24 * 60 * 60 * 1000));
}

// "March 2026" for a single month, "March to May 2026" for a longer slip.
function monthRangeLabel(slip) {
  const count = Number(slip.months_count) || 1;
  const start = MONTHS[slip.month - 1];

  if (count === 1) return start + " " + slip.year;

  const zero = slip.month - 1 + (count - 1);
  const endMonth = MONTHS[zero % 12];
  const endYear = slip.year + Math.floor(zero / 12);

  return start + " to " + endMonth + " " + endYear;
}

// Adds late fee + totals to a slip row so the frontend does no maths.
function withTotals(slip) {
  const lateFee = calcLateFee(slip);
  const late = daysOverdue(slip);
  const payable =
    Number(slip.tuition_fee) +
    Number(slip.other_fee) +
    lateFee -
    Number(slip.discount);
  const balance = payable - Number(slip.paid_amount);

  return {
    ...slip,
    tuition_fee: Number(slip.tuition_fee),
    other_fee: Number(slip.other_fee),
    discount: Number(slip.discount),
    paid_amount: Number(slip.paid_amount),
    late_fee: lateFee,
    total: payable,
    balance: balance,
    months_count: Number(slip.months_count) || 1,
    month_label: monthRangeLabel(slip),
    days_overdue: balance > 0 ? late : 0,
    is_overdue: balance > 0 && late > 0,
  };
}

module.exports = {
  upload, notify, calcLateFee, daysOverdue, withTotals, monthRangeLabel, MONTHS,
  cleanPhone, cleanCnic,
  DEFAULT_PASSWORD, randomPassword, nextAdmissionNo, schoolEmail, parentClash,
  emailOwner, staffEmail, WEEKLY_HOLIDAY, DAY_NAMES, parentIdentity, phoneIdentity, phoneProblem,
  getAttendanceWindow, isWithinWindow, friendlyTime, logAudit,
  resolveRange, todayText, asDateText,
};
