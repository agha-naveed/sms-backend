// Fills the database with sample data so you can log in and try everything.
// Run it with:  npm run seed
// It clears the tables first, so do not run it on real data.
require("dotenv").config();
const { pool, query } = require("./db");
const { hashPassword } = require("./auth");

async function addUser(name, email, password, role, phone) {
  const rows = await query(
    `INSERT INTO users (full_name, email, password, phone, role)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [name, email, hashPassword(password), phone || null, role]
  );
  return rows[0];
}

async function seed() {
  console.log("Clearing old data...");

  // TRUNCATE ... CASCADE reaches every table with a foreign key back to
  // users or classes, which includes audit_logs - and the audit log
  // refuses to be truncated (see migration-12.sql), on purpose, so the
  // application can never clear it. This script is run by hand with full
  // database credentials, the same trust level as direct DB access, so it
  // explicitly lifts that one protection for its own run, then puts it
  // straight back.
  await query("ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_truncate");
  try {
    await query(`TRUNCATE users, classes RESTART IDENTITY CASCADE`);
  } finally {
    await query("ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_truncate");
  }

  // ---- admin ----
  console.log("Creating accounts...");
  await addUser("School Admin", "admin@school.com", "12345", "admin", "+923001234567");

  // ---- classes, sections, subjects ----
  const classNames = [
    { name: "Class 1", fee: 2500 },
    { name: "Class 2", fee: 2800 },
    { name: "Class 5", fee: 3500 },
  ];

  const classIds = [];

  for (const c of classNames) {
    const rows = await query(
      "INSERT INTO classes (name, monthly_fee) VALUES ($1,$2) RETURNING id",
      [c.name, c.fee]
    );
    classIds.push(rows[0].id);

    for (const s of ["A", "B"]) {
      await query("INSERT INTO sections (class_id, name) VALUES ($1,$2)", [rows[0].id, s]);
    }
    for (const sub of ["English", "Mathematics", "Urdu", "Science"]) {
      await query("INSERT INTO subjects (class_id, name) VALUES ($1,$2)", [rows[0].id, sub]);
    }
  }

  const sections = await query("SELECT * FROM sections ORDER BY id");
  const subjects = await query("SELECT * FROM subjects ORDER BY id");

  // ---- teacher, assigned to Class 1 section A and B ----
  const teacherUser = await addUser("Ayesha Malik", "ayesha.malik@school.com", "12345", "teacher", "+923011111111");
  const teacher = await query(
    "INSERT INTO teachers (user_id, qualification) VALUES ($1,$2) RETURNING *",
    [teacherUser.id, "M.Sc Mathematics"]
  );

  const class1Sections = sections.filter(function (s) { return s.class_id === classIds[0]; });
  const class1Maths = subjects.find(function (s) {
    return s.class_id === classIds[0] && s.name === "Mathematics";
  });

  for (const sec of class1Sections) {
    await query(
      `INSERT INTO teacher_classes (teacher_id, class_id, section_id, subject_id)
       VALUES ($1,$2,$3,$4)`,
      [teacher[0].id, classIds[0], sec.id, class1Maths.id]
    );
  }

  // ---- parent with two children ----
  const parentUser = await addUser("Ahmed Khan", "parent@school.com", "12345", "parent", "+923022222222");
  const parent = await query(
    "INSERT INTO parents (user_id, cnic, occupation) VALUES ($1,$2,$3) RETURNING *",
    [parentUser.id, "35202-1234567-1", "Shopkeeper"]
  );

  // Students may share a parent's number; only parent accounts must be unique.
  const children = [
    { name: "Ali Khan", email: "2026-0001@school.com", pass: "12345" },
    { name: "Sara Khan", email: "2026-0002@school.com", pass: "12345" },
  ];

  const studentIds = [];

  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    const u = await addUser(c.name, c.email, c.pass, "student", "+923022222222");
    const rows = await query(
      `INSERT INTO students (user_id, parent_id, class_id, section_id, admission_no, gender)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [
        u.id,
        parent[0].id,
        classIds[0],
        class1Sections[0].id,
        "2026-000" + (i + 1),
        i === 0 ? "Male" : "Female",
      ]
    );
    studentIds.push(rows[0].id);
  }

  // a few more students so the class list is not empty
  for (let i = 3; i <= 8; i++) {
    const u = await addUser("Student " + i, "2026-000" + i + "@school.com", "12345", "student", null);
    const rows = await query(
      `INSERT INTO students (user_id, class_id, section_id, admission_no)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [u.id, classIds[0], class1Sections[0].id, "2026-000" + i]
    );
    studentIds.push(rows[0].id);
  }

  // ---- a waiting admission application ----
  await query(
    `INSERT INTO admissions
       (student_name, gender, dob, applying_class_id, parent_name, parent_email, parent_phone, address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      "Hamza Iqbal",
      "Male",
      "2018-04-12",
      classIds[0],
      "Iqbal Hussain",
      "iqbal@example.com",
      "+923033333333",
      "Jutial, Gilgit",
    ]
  );

  // ---- one notice ----
  const admin = await query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  await query(
    `INSERT INTO notices (title, body, audience, is_important, created_by)
     VALUES ($1,$2,$3,$4,$5)`,
    [
      "Parent-teacher meeting on Saturday",
      "The meeting starts at 10:00 AM in the school hall. Please bring your child's diary.",
      "all",
      true,
      admin[0].id,
    ]
  );

  // ---- fee slips for last month ----
  const now = new Date();
  const month = now.getMonth() === 0 ? 12 : now.getMonth();
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();

  for (const id of studentIds) {
    const student = await query(
      "SELECT s.admission_no, c.monthly_fee FROM students s JOIN classes c ON c.id = s.class_id WHERE s.id = $1",
      [id]
    );
    await query(
      `INSERT INTO fee_slips (student_id, slip_no, month, year, tuition_fee, due_date)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        id,
        "FEE-" + year + String(month).padStart(2, "0") + "-" + student[0].admission_no,
        month,
        year,
        student[0].monthly_fee,
        year + "-" + String(month).padStart(2, "0") + "-10",
      ]
    );
  }

  // ---- some marks so the result report is not empty ----
  const mathsId = class1Maths.id;
  const englishId = subjects.find(function (x) {
    return x.class_id === classIds[0] && x.name === "English";
  }).id;

  const scores = [78, 91, 45, 62, 33, 88, 55, 70];

  for (let i = 0; i < studentIds.length; i++) {
    for (const subjectId of [mathsId, englishId]) {
      const offset = subjectId === mathsId ? 0 : 5;
      let mark = scores[i % scores.length] - offset;
      if (mark < 0) mark = 0;
      if (mark > 100) mark = 100;

      await query(
        `INSERT INTO results (student_id, subject_id, exam_name, total_marks, obtained_marks)
         VALUES ($1,$2,'Mid Term',100,$3)`,
        [studentIds[i], subjectId, mark]
      );
    }
  }

  console.log("");
  console.log("Done. You can log in with:");
  console.log("  Admin    admin@school.com     / 12345");
  console.log("  Teacher  ayesha.malik@school.com / 12345");
  console.log("  Parent   parent@school.com    / 12345");
  console.log("  Student  2026-0001@school.com / 12345");
  console.log("");
  console.log("  Students can also sign in with just their registration");
  console.log("  number, for example 2026-0001");
  console.log("");

  await pool.end();
}

seed().catch(function (err) {
  console.error("Seeding failed:", err.message);
  process.exit(1);
});
