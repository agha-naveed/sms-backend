// Login helpers and role checking (RBAC).
require("dotenv").config();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { queryOne } = require("./db");

const SECRET = process.env.JWT_SECRET || "dev_secret_change_me";

// ---- passwords -------------------------------------------------
function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

function checkPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

// ---- tokens ----------------------------------------------------
function makeToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, name: user.full_name },
    SECRET,
    { expiresIn: "1d" }
  );
}

// ---- middleware ------------------------------------------------
// Reads "Authorization: Bearer <token>" and puts the user on req.user.
function requireLogin(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: "Please log in first." });
  }

  try {
    req.user = jwt.verify(token, SECRET);
  } catch (err) {
    return res.status(401).json({ message: "Your session expired. Log in again." });
  }

  // A parent whose children have all left the school can only open the
  // dashboard (and their own profile check). Everything else is closed.
  if (req.user.role !== "parent") return next();

  const url = req.originalUrl.split("?")[0].replace(/\/+$/, "");
  const allowed = req.method === "GET" && (url === "/api/auth/me" || url === "/api/dashboard");
  if (allowed) return next();

  queryOne(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE s.status = 'active')::int AS active
       FROM students s JOIN parents p ON p.id = s.parent_id
      WHERE p.user_id = $1`,
    [req.user.id]
  )
    .then(function (row) {
      if (row && row.total > 0 && row.active === 0) {
        return res.status(403).json({
          message: "Your children have left the school, so this account can only view the dashboard.",
        });
      }
      next();
    })
    .catch(function () { next(); });
}

// Use like:  router.get("/", requireLogin, allow("admin"), handler)
// or:        allow("admin", "teacher")
function allow(...roles) {
  return function (req, res, next) {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: "You do not have access to this." });
    }
    next();
  };
}

// ---- small lookups used by many routes -------------------------
// Gets the students row for a logged-in student user.
async function getStudentOfUser(userId) {
  return await queryOne("SELECT * FROM students WHERE user_id = $1", [userId]);
}

// Gets the parents row for a logged-in parent user.
async function getParentOfUser(userId) {
  return await queryOne("SELECT * FROM parents WHERE user_id = $1", [userId]);
}

// Gets the teachers row for a logged-in teacher user.
async function getTeacherOfUser(userId) {
  return await queryOne("SELECT * FROM teachers WHERE user_id = $1", [userId]);
}

// Is this parent allowed to look at this student? (own children only)
async function parentOwnsStudent(userId, studentId) {
  const row = await queryOne(
    `SELECT s.id
       FROM students s
       JOIN parents p ON p.id = s.parent_id
      WHERE p.user_id = $1 AND s.id = $2`,
    [userId, studentId]
  );
  return Boolean(row);
}

// Is this teacher assigned to this class + section?
async function teacherOwnsSection(userId, classId, sectionId) {
  const row = await queryOne(
    `SELECT tc.id
       FROM teacher_classes tc
       JOIN teachers t ON t.id = tc.teacher_id
      WHERE t.user_id = $1 AND tc.class_id = $2 AND tc.section_id = $3
      LIMIT 1`,
    [userId, classId, sectionId]
  );
  return Boolean(row);
}

// Is this teacher the class teacher of this section? Only the class teacher
// may mark that section's attendance.
async function teacherIsClassTeacher(userId, classId, sectionId) {
  const row = await queryOne(
    `SELECT sec.id
       FROM sections sec
       JOIN teachers t ON t.id = sec.class_teacher_id
      WHERE t.user_id = $1 AND sec.class_id = $2 AND sec.id = $3
      LIMIT 1`,
    [userId, classId, sectionId]
  );
  return Boolean(row);
}

// Is this teacher allowed to enter marks for this subject, in this section?
// A row with subject_id NULL means the teacher takes that section for any
// subject, so that counts as yes.
async function teacherOwnsSubject(userId, classId, sectionId, subjectId) {
  const row = await queryOne(
    `SELECT tc.id
       FROM teacher_classes tc
       JOIN teachers t ON t.id = tc.teacher_id
      WHERE t.user_id = $1
        AND tc.class_id = $2
        AND tc.section_id = $3
        AND (tc.subject_id IS NULL OR tc.subject_id = $4)
      LIMIT 1`,
    [userId, classId, sectionId, subjectId]
  );
  return Boolean(row);
}

module.exports = {
  hashPassword,
  checkPassword,
  makeToken,
  requireLogin,
  allow,
  getStudentOfUser,
  getParentOfUser,
  getTeacherOfUser,
  parentOwnsStudent,
  teacherOwnsSection,
  teacherIsClassTeacher,
  teacherOwnsSubject,
};
