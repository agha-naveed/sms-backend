// Bulk-add existing students from an Excel (.xlsx) or CSV file.
//
//   GET  /api/student-import/template   an Excel file to fill in
//   POST /api/student-import            upload the filled file (field "file")
//
// Parents are matched by Parent Email first, then by Parent CNIC (the same
// CNIC is the same parent). A parent with no email gets a school email made
// from the registration number of their first child.
//
// The upload is all-or-nothing. Every row is checked first; if any row has a
// problem nothing is saved and the problems are listed by row number, so the
// admin can fix the sheet and upload it again without making duplicates.
const express = require("express");
const multer = require("multer");
const path = require("path");
const ExcelJS = require("exceljs");
const { pool, query, queryOne } = require("../db");
const { requireLogin, allow, hashPassword } = require("../auth");
const {
  cleanPhone, cleanCnic, DEFAULT_PASSWORD, nextAdmissionNo, schoolEmail,
  phoneIdentity, phoneProblem, parentClash, parentSchoolEmail, logAudit,
} = require("../helpers");

const router = express.Router();
router.use(requireLogin);
router.use(allow("admin"));

const MAX_ROWS = 1000;

const receive = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: function (req, file, done) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === ".xlsx" || ext === ".csv") return done(null, true);
    done(new Error("Upload an Excel file (.xlsx) or a CSV file. Old .xls files must be saved as .xlsx first."));
  },
});

// Column headings the sheet may use (case, spaces and punctuation ignored).
const COLUMNS = {
  name: ["name", "studentname", "fullname", "student"],
  class: ["class", "classname", "grade"],
  section: ["section", "sectionname"],
  gender: ["gender", "sex"],
  dob: ["dob", "dateofbirth", "birthdate", "birthday"],
  address: ["address"],
  phone: ["phone", "mobile", "studentphone", "studentmobile", "phoneno"],
  admission_no: ["admissionno", "admissionnumber", "registrationno", "registrationnumber", "regno", "rollno"],
  email: ["email", "studentemail", "loginemail"],
  parent_name: ["parentname", "fathername", "guardianname", "parent", "father"],
  parent_email: ["parentemail", "fatheremail", "guardianemail"],
  parent_phone: ["parentphone", "parentmobile", "fatherphone", "fathermobile", "guardianphone"],
  parent_cnic: ["parentcnic", "fathercnic", "guardiancnic", "cnic"],
};

function squash(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Excel cells can hold text, numbers, dates, formulas or links.
function cellText(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    if (value.result !== undefined) return cellText(value.result);
    if (value.text !== undefined) return String(value.text).trim();
    if (Array.isArray(value.richText)) return value.richText.map(function (r) { return r.text; }).join("").trim();
    return "";
  }
  return String(value).trim();
}

// Turns a date cell or text such as 2012-05-14, 14/05/2012 into "YYYY-MM-DD".
function toIsoDate(value) {
  if (!value) return { ok: true, value: null };

  let d;
  if (value instanceof Date) {
    d = value;
  } else {
    const text = String(value).trim();
    let m = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (m) {
      d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    } else {
      m = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
      if (m) d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
    }
    if (!d) return { ok: false };
  }

  if (isNaN(d.getTime())) return { ok: false };
  const year = d.getUTCFullYear();
  if (year < 1990 || d.getTime() > Date.now()) return { ok: false };
  return { ok: true, value: d.toISOString().slice(0, 10) };
}

function toGender(text) {
  const g = squash(text);
  if (!g) return { ok: true, value: null };
  if (g === "male" || g === "m" || g === "boy") return { ok: true, value: "Male" };
  if (g === "female" || g === "f" || g === "girl") return { ok: true, value: "Female" };
  return { ok: false };
}

// ------------------------------------------------------------------
// GET /api/student-import/template
// ------------------------------------------------------------------
router.get("/template", async function (req, res) {
  try {
    const wb = new ExcelJS.Workbook();

    const sheet = wb.addWorksheet("Students");
    sheet.columns = [
      { header: "Name", key: "name", width: 24 },
      { header: "Class", key: "class", width: 12 },
      { header: "Section", key: "section", width: 10 },
      { header: "Gender", key: "gender", width: 10 },
      { header: "Date of Birth", key: "dob", width: 16 },
      { header: "Address", key: "address", width: 28 },
      { header: "Phone", key: "phone", width: 16 },
      { header: "Admission No", key: "admission_no", width: 16 },
      { header: "Email", key: "email", width: 24 },
      { header: "Parent Name", key: "parent_name", width: 22 },
      { header: "Parent Email", key: "parent_email", width: 26 },
      { header: "Parent Phone", key: "parent_phone", width: 16 },
      { header: "Parent CNIC", key: "parent_cnic", width: 18 },
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];

    // Phone, CNIC and admission numbers must stay text or Excel drops leading zeros.
    ["phone", "admission_no", "parent_phone", "parent_cnic"].forEach(function (key) {
      sheet.getColumn(key).numFmt = "@";
    });

    sheet.addRow({
      name: "Ali Raza", class: "Class 5", section: "A", gender: "Male", dob: "2014-05-14",
      address: "Main Road, Gilgit", phone: "", admission_no: "", email: "",
      parent_name: "Raza Hussain", parent_email: "raza@example.com",
      parent_phone: "0300 1234567", parent_cnic: "12345-1234567-1",
    });

    const help = wb.addWorksheet("Read me");
    help.columns = [{ width: 110 }];
    [
      "HOW TO FILL IN THE STUDENTS SHEET",
      "",
      "Required: Name, Class, Section. Everything else can be left empty.",
      "Class and Section must match the names already set up in the system (see the Classes sheet).",
      "Delete the example row before you upload, and keep the first row (the headings) as it is.",
      "Date of Birth: write it as 2014-05-14 or 14/05/2014.",
      "Gender: Male or Female.",
      "Admission No and Email: leave empty to have them made automatically (for example 2026-0007 and 2026-0007@school.com).",
      "Parent: fill in Parent Name (and Parent CNIC if you have it). Parent Email is optional.",
      "The same parent is recognised by Parent Email or by Parent CNIC. Brothers and sisters with the same Parent CNIC (or Parent Email) are linked to one parent, even if that parent already has an account.",
      "If a parent has no email, a school email is made for them, for example parent-2026-0007@school.com. It is listed in the login file after the import.",
      "Two different parents with the same name stay separate unless their CNIC or email match.",
      "Every new student and new parent gets the starting password " + DEFAULT_PASSWORD + ".",
      "If any row has a problem, nothing is saved. You will see the row numbers to fix, then upload again.",
      "Up to " + MAX_ROWS + " students per file.",
    ].forEach(function (line, i) {
      const row = help.addRow([line]);
      if (i === 0) row.font = { bold: true };
    });

    const classRows = await query(
      `SELECT c.name AS class_name, sec.name AS section_name
         FROM classes c LEFT JOIN sections sec ON sec.class_id = c.id
        ORDER BY c.name, sec.name`
    );
    const ref = wb.addWorksheet("Classes");
    ref.columns = [{ header: "Class", width: 20 }, { header: "Section", width: 12 }];
    ref.getRow(1).font = { bold: true };
    classRows.forEach(function (r) { ref.addRow([r.class_name, r.section_name || ""]); });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="students-import-template.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ message: "Could not create the template." });
  }
});

// Reads the uploaded file into plain row objects: [{ rowNumber, name, class, ... }]
async function readRows(file) {
  const wb = new ExcelJS.Workbook();
  const ext = path.extname(file.originalname).toLowerCase();

  if (ext === ".csv") {
    const { Readable } = require("stream");
    await wb.csv.read(Readable.from([file.buffer]));
  } else {
    await wb.xlsx.load(file.buffer);
  }

  const sheet = wb.getWorksheet("Students") || wb.worksheets[0];
  if (!sheet) throw new Error("The file has no sheet.");

  // Find which column holds what, from the heading row.
  const headerRow = sheet.getRow(1);
  const where = {};
  headerRow.eachCell(function (cell, col) {
    const key = squash(cellText(cell.value));
    Object.keys(COLUMNS).forEach(function (field) {
      if (where[field] === undefined && COLUMNS[field].includes(key)) where[field] = col;
    });
  });

  const missing = ["name", "class", "section"].filter(function (f) { return where[f] === undefined; });
  if (missing.length > 0) {
    throw new Error(
      "The first row must have the headings Name, Class and Section. Missing: " +
        missing.map(function (m) { return m.charAt(0).toUpperCase() + m.slice(1); }).join(", ") +
        ". Download the template to see the right layout."
    );
  }

  const rows = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const item = { rowNumber: r };
    let any = false;

    Object.keys(where).forEach(function (field) {
      const v = cellText(row.getCell(where[field]).value);
      item[field] = v;
      if (v !== "") any = true;
    });

    if (any) rows.push(item);
  }
  return rows;
}

// ------------------------------------------------------------------
// POST /api/student-import
// ------------------------------------------------------------------
router.post("/", function (req, res) {
  receive.single("file")(req, res, async function (uploadErr) {
    if (uploadErr) return res.status(400).json({ message: uploadErr.message });
    if (!req.file) return res.status(400).json({ message: "Choose an Excel file to upload." });

    let rows;
    try {
      rows = await readRows(req.file);
    } catch (e) {
      return res.status(400).json({ message: e.message || "Could not read that file." });
    }

    if (rows.length === 0) return res.status(400).json({ message: "The file has no students in it." });
    if (rows.length > MAX_ROWS) {
      return res.status(400).json({ message: "Upload at most " + MAX_ROWS + " students at a time." });
    }

    try {
      // ---------- 1. Check every row, change nothing ----------
      const classList = await query("SELECT id, name FROM classes");
      const sectionList = await query("SELECT id, class_id, name FROM sections");

      const takenNumbers = new Set(
        (await query("SELECT admission_no FROM students")).map(function (r) { return r.admission_no; })
      );
      const takenEmails = new Set(
        (await query("SELECT email FROM users")).map(function (r) { return r.email.toLowerCase(); })
      );

      // The next free number for rows that did not bring their own.
      const first = await nextAdmissionNo();
      const prefix = first.split("-")[0];
      let counter = Number(first.split("-")[1]);

      function freshAdmissionNo() {
        for (;;) {
          const candidate = prefix + "-" + String(counter++).padStart(4, "0");
          if (!takenNumbers.has(candidate) && !takenEmails.has(schoolEmail(candidate).toLowerCase())) return candidate;
        }
      }

      const errors = [];
      const plans = [];

      // Parents met earlier in this same file, so brothers and sisters share
      // one. Found by email ("e:...") or by CNIC ("c:...").
      const batchParents = new Map();
      const batchPhone = new Map();     // mobile number -> parent key
      let parentCounter = 0;

      for (const r of rows) {
        const problems = [];
        const add = function (text) { problems.push(text); };

        if (!r.name) add("Name is empty.");

        // Class and section by name. "5" also matches "Class 5".
        const classKey = squash(r.class);
        const cls = classList.find(function (c) {
          return squash(c.name) === classKey || squash(c.name) === "class" + classKey;
        });
        let section = null;
        if (!r.class) add("Class is empty.");
        else if (!cls) add('Class "' + r.class + '" does not exist.');

        if (!r.section) add("Section is empty.");
        else if (cls) {
          section = sectionList.find(function (s) { return s.class_id === cls.id && squash(s.name) === squash(r.section); });
          if (!section) add("Section " + r.section + " does not exist in " + cls.name + ".");
        }

        const gender = toGender(r.gender);
        if (!gender.ok) add('Gender "' + r.gender + '" must be Male or Female.');

        const dob = toIsoDate(r.dob);
        if (!dob.ok) add('Date of Birth "' + (r.dob instanceof Date ? "" : r.dob) + '" is not a valid date. Use 2014-05-14 or 14/05/2014.');

        const phone = cleanPhone(r.phone);
        if (r.phone && !phone) add("Phone must be a Pakistani mobile number, for example 0300 1234567.");

        // Registration number and login email.
        let admissionNo = r.admission_no ? String(r.admission_no).trim() : "";
        if (admissionNo) {
          if (takenNumbers.has(admissionNo)) add("Admission No " + admissionNo + " is already used.");
        } else {
          admissionNo = freshAdmissionNo();
        }

        const email = (r.email || schoolEmail(admissionNo)).trim();
        if (r.email && !/^\S+@\S+\.\S+$/.test(email)) add('Email "' + email + '" is not valid.');
        if (takenEmails.has(email.toLowerCase())) add("The email " + email + " is already used.");

        // Reserve them so later rows in this file cannot reuse them.
        takenNumbers.add(admissionNo);
        takenEmails.add(email.toLowerCase());

        // Parent. The same parent is found by email first, then by CNIC.
        // A parent with no email gets a school email made from this
        // student's registration number.
        let parent = null;
        const emailGiven = (r.parent_email || "").trim();

        if (r.parent_name || emailGiven || r.parent_cnic) {
          const parentPhone = cleanPhone(r.parent_phone);
          const parentCnic = cleanCnic(r.parent_cnic);
          let parentOk = true;

          if (emailGiven && !/^\S+@\S+\.\S+$/.test(emailGiven)) {
            add('Parent Email "' + emailGiven + '" is not valid.');
            parentOk = false;
          }
          if (r.parent_phone && !parentPhone) {
            add("Parent Phone must be a Pakistani mobile number, for example 0300 1234567.");
            parentOk = false;
          }
          if (r.parent_cnic && !parentCnic) {
            add("Parent CNIC must have 13 digits.");
            parentOk = false;
          }

          if (parentOk) {
            const emailKey = emailGiven.toLowerCase();

            // Already met earlier in this file?
            parent =
              (emailKey && batchParents.get("e:" + emailKey)) ||
              (parentCnic && batchParents.get("c:" + parentCnic)) ||
              null;

            // Already in the system, by email?
            if (!parent && emailKey) {
              const existing = await queryOne("SELECT * FROM users WHERE LOWER(email) = $1", [emailKey]);

              if (existing && existing.role !== "parent") {
                add(emailGiven + " is already used by " + existing.full_name + " (" + existing.role + ").");
                parentOk = false;
              } else if (existing) {
                parent = { key: "p" + (++parentCounter), name: existing.full_name, email: existing.email, existingUserId: existing.id };
              }
            }

            // Already in the system, by CNIC?
            if (!parent && parentOk && parentCnic) {
              const sameCnic = await queryOne(
                `SELECT p.id, u.full_name, u.email FROM parents p
                   JOIN users u ON u.id = p.user_id WHERE p.cnic = $1 LIMIT 1`,
                [parentCnic]
              );
              if (sameCnic) {
                parent = { key: "p" + (++parentCounter), name: sameCnic.full_name, email: sameCnic.email, existingParentId: sameCnic.id };
              }
            }

            // Nobody found, so this is a new parent.
            if (!parent && parentOk) {
              if (!r.parent_name) {
                add("Parent Name is needed to create a new parent.");
              } else {
                const loginEmail = emailGiven || parentSchoolEmail(admissionNo);

                if (!emailGiven && takenEmails.has(loginEmail.toLowerCase())) {
                  add("The school email " + loginEmail + " for the parent is already used. Fill in a Parent Email for this row.");
                } else {
                  const phoneMessage = phoneProblem(await phoneIdentity(parentPhone, r.parent_name, "parent", null), parentPhone);
                  if (phoneMessage) add(phoneMessage);

                  const clash = await parentClash(null, parentPhone, null);
                  if (clash) add("Parent " + clash.field + " already belongs to " + clash.name + " (" + clash.email + ").");

                  parent = {
                    key: "p" + (++parentCounter), name: r.parent_name, email: loginEmail,
                    phone: parentPhone, cnic: parentCnic, address: r.address || null, isNew: true,
                  };
                  takenEmails.add(loginEmail.toLowerCase());
                }
              }
            }

            // A mobile number belongs to one parent, also inside this file.
            if (parent && parent.isNew && parentPhone) {
              if (batchPhone.has(parentPhone) && batchPhone.get(parentPhone) !== parent.key) {
                add("Parent Phone is used by another parent in this file.");
              }
              batchPhone.set(parentPhone, parent.key);
            }

            if (parent) {
              if (emailKey) batchParents.set("e:" + emailKey, parent);
              batchParents.set("e:" + parent.email.toLowerCase(), parent);
              if (parentCnic) batchParents.set("c:" + parentCnic, parent);
            }
          }
        }

        if (problems.length > 0) {
          problems.forEach(function (p) { errors.push({ row: r.rowNumber, message: p }); });
        } else {
          plans.push({
            row: r.rowNumber, name: r.name, classId: cls.id, className: cls.name,
            sectionId: section.id, sectionName: section.name,
            gender: gender.value, dob: dob.value, address: r.address || null,
            phone: phone, admissionNo: admissionNo, email: email, parent: parent,
          });
        }
      }

      if (errors.length > 0) {
        const shown = errors.slice(0, 100);
        return res.status(400).json({
          message: errors.length + " problem" + (errors.length === 1 ? "" : "s") +
            " found. Nothing was saved. Fix the rows below and upload again.",
          errors: shown,
          more: errors.length - shown.length,
        });
      }

      // ---------- 2. Save everything together or nothing ----------
      const client = await pool.connect();
      const students = [];
      const parentLogins = [];

      try {
        await client.query("BEGIN");

        const passwordHash = hashPassword(DEFAULT_PASSWORD);
        const parentIds = new Map();   // email key -> parents.id

        for (const p of plans) {
          let parentId = null;

          if (p.parent) {
            if (parentIds.has(p.parent.key)) {
              parentId = parentIds.get(p.parent.key);
            } else if (p.parent.existingParentId) {
              parentId = p.parent.existingParentId;
              parentIds.set(p.parent.key, parentId);
            } else if (p.parent.existingUserId) {
              let row = (await client.query("SELECT id FROM parents WHERE user_id = $1", [p.parent.existingUserId])).rows[0];
              if (!row) {
                row = (await client.query(
                  "INSERT INTO parents (user_id, cnic, address) VALUES ($1,NULL,$2) RETURNING id",
                  [p.parent.existingUserId, p.address]
                )).rows[0];
              }
              parentId = row.id;
              parentIds.set(p.parent.key, parentId);
            } else {
              const user = (await client.query(
                `INSERT INTO users (full_name, email, password, phone, role)
                 VALUES ($1,$2,$3,$4,'parent') RETURNING id`,
                [p.parent.name, p.parent.email, passwordHash, p.parent.phone]
              )).rows[0];
              const row = (await client.query(
                "INSERT INTO parents (user_id, cnic, address) VALUES ($1,$2,$3) RETURNING id",
                [user.id, p.parent.cnic, p.parent.address]
              )).rows[0];
              parentId = row.id;
              parentIds.set(p.parent.key, parentId);
              parentLogins.push({ name: p.parent.name, email: p.parent.email, password: DEFAULT_PASSWORD });
            }
          }

          const user = (await client.query(
            `INSERT INTO users (full_name, email, password, phone, role)
             VALUES ($1,$2,$3,$4,'student') RETURNING id`,
            [p.name, p.email, passwordHash, p.phone]
          )).rows[0];

          await client.query(
            `INSERT INTO students
               (user_id, parent_id, class_id, section_id, admission_no, gender, dob, address)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [user.id, parentId, p.classId, p.sectionId, p.admissionNo, p.gender, p.dob, p.address]
          );

          students.push({
            name: p.name, admission_no: p.admissionNo, email: p.email, password: DEFAULT_PASSWORD,
            class_name: p.className, section_name: p.sectionName,
            parent_name: p.parent ? p.parent.name : "", parent_email: p.parent ? p.parent.email : "",
          });
        }

        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        console.error(e);
        const clash = e.code === "23505";
        return res.status(400).json({
          message: clash
            ? "Someone with the same registration number or email was added while you were uploading. Nothing was saved. Try again."
            : "Could not save the students. Nothing was saved.",
        });
      } finally {
        client.release();
      }

      logAudit(req.user, "created", "student", students.length + " students imported from Excel");

      res.status(201).json({
        message: students.length + " student" + (students.length === 1 ? "" : "s") + " added.",
        created: students.length,
        students: students,
        parent_logins: parentLogins,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Could not import the file." });
    }
  });
});

module.exports = router;
