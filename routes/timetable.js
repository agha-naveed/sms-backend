// A weekly grid per class + section, built from a shared list of periods.
// The admin can see and edit any class's grid at any time. Everyone else
// (teacher, student, parent) only ever sees it once the admin publishes
// that section, and only the part that is theirs:
//   - a student/parent sees their own class + section's grid
//   - a teacher sees a personal weekly grid assembled from every slot
//     where they are the teacher, across every published section
//
// The one rule that must never be broken: a teacher cannot be in two
// places in the same period on the same day. That is checked here before
// saving, AND enforced by a database constraint as a second safety net -
// so this can never silently happen even if two admins save at once.
const express = require("express");
const { query, queryOne } = require("../db");
const {
  requireLogin, allow, teacherOwnsSection, parentOwnsStudent, getStudentOfUser, getTeacherOfUser,
} = require("../auth");
const { DAY_NAMES, WEEKLY_HOLIDAY, logAudit } = require("../helpers");
const { newDocument, addTimetablePage, sendPdf } = require("../timetablePdf");

const router = express.Router();
router.use(requireLogin);

// Monday first, the weekly holiday left out, matching how people actually
// think about a school week.
function schoolDays() {
  const order = [1, 2, 3, 4, 5, 6, 0];
  return order.filter(function (d) { return d !== WEEKLY_HOLIDAY; });
}

// "HH:MM" <-> minutes since midnight, for building and checking periods.
function toMinutes(hhmm) {
  const parts = String(hhmm).split(":");
  return Number(parts[0]) * 60 + Number(parts[1] || 0);
}

function toHHMM(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

// ------------------------------------------------------------------
// PERIODS  (shared by the whole school)
// Each one is a "class" or a "break".
// ------------------------------------------------------------------
router.get("/periods", async function (req, res) {
  try {
    const rows = await query("SELECT * FROM periods ORDER BY start_time");
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load periods." });
  }
});

router.post("/periods", allow("admin"), async function (req, res) {
  try {
    const { start_time, end_time } = req.body;
    const kind = req.body.kind === "break" ? "break" : "class";
    const label = (req.body.label || (kind === "break" ? "Break" : "")).trim();

    if (!label || !start_time || !end_time) {
      return res.status(400).json({ message: "Fill in the label, start time and end time." });
    }
    if (start_time >= end_time) {
      return res.status(400).json({ message: "The start time must be before the end time." });
    }

    // Periods and breaks share one day, so their times must not overlap.
    const overlap = await queryOne(
      `SELECT label FROM periods
        WHERE start_time < $2::time AND end_time > $1::time LIMIT 1`,
      [start_time, end_time]
    );
    if (overlap) {
      return res.status(400).json({ message: "That time overlaps with " + overlap.label + "." });
    }

    const row = await queryOne(
      "INSERT INTO periods (label, start_time, end_time, kind) VALUES ($1,$2,$3,$4) RETURNING *",
      [label, start_time, end_time, kind]
    );

    logAudit(req.user, "created", "period", label + " (" + start_time + "-" + end_time + ", " + kind + ")");
    res.status(201).json(row);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({ message: "A period already starts at that time." });
    }
    console.error(err);
    res.status(500).json({ message: "Could not add the period." });
  }
});

// POST /api/timetable/periods/generate
// Builds the whole school day in one go from simple numbers:
//   { start_time: "08:00", class_minutes: 40, count: 7,
//     breaks: [{ after: 3, minutes: 20, label: "Break" }],
//     replace: true }
// Classes are made back to back, and each break is slotted in after the
// class number given. If periods already exist, replace must be true;
// that clears the old periods and any timetable boxes that used them.
router.post("/periods/generate", allow("admin"), async function (req, res) {
  try {
    const startTime = req.body.start_time;
    const classMinutes = Number(req.body.class_minutes);
    const count = Number(req.body.count);
    const replace = Boolean(req.body.replace);
    const breaks = (Array.isArray(req.body.breaks) ? req.body.breaks : [])
      .map(function (b) {
        return { after: Number(b.after), minutes: Number(b.minutes), label: (b.label || "Break").trim() || "Break" };
      })
      .filter(function (b) { return b.minutes > 0; });

    if (!startTime) return res.status(400).json({ message: "Choose when the school day starts." });
    if (!Number.isInteger(classMinutes) || classMinutes < 5 || classMinutes > 180) {
      return res.status(400).json({ message: "A class must be between 5 and 180 minutes long." });
    }
    if (!Number.isInteger(count) || count < 1 || count > 15) {
      return res.status(400).json({ message: "Choose between 1 and 15 classes." });
    }
    for (const b of breaks) {
      if (!Number.isInteger(b.after) || b.after < 1 || b.after >= count) {
        return res.status(400).json({ message: "A break must come after one of the classes, but not after the last one." });
      }
      if (!Number.isInteger(b.minutes) || b.minutes > 120) {
        return res.status(400).json({ message: "A break can be at most 120 minutes." });
      }
    }
    const afterNumbers = breaks.map(function (b) { return b.after; });
    if (new Set(afterNumbers).size !== afterNumbers.length) {
      return res.status(400).json({ message: "Two breaks cannot come after the same class." });
    }

    // Work out every row first, so a day that runs past midnight is caught
    // before anything is changed.
    const rows = [];
    let cursor = toMinutes(startTime);
    for (let i = 1; i <= count; i++) {
      rows.push({ label: "Period " + i, start: cursor, end: cursor + classMinutes, kind: "class" });
      cursor += classMinutes;

      const brk = breaks.find(function (b) { return b.after === i; });
      if (brk) {
        rows.push({ label: brk.label, start: cursor, end: cursor + brk.minutes, kind: "break" });
        cursor += brk.minutes;
      }
    }
    if (cursor > 24 * 60) {
      return res.status(400).json({ message: "That schedule runs past midnight. Use fewer or shorter classes." });
    }

    const existing = await queryOne("SELECT COUNT(*)::int AS total FROM periods");
    if (existing.total > 0 && !replace) {
      return res.status(400).json({
        message: "Periods already exist. Confirm that you want to replace them (this also clears the class timetables built on them).",
      });
    }

    // Replace everything together or not at all.
    const { pool } = require("../db");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM periods");
      for (const r of rows) {
        await client.query(
          "INSERT INTO periods (label, start_time, end_time, kind) VALUES ($1,$2,$3,$4)",
          [r.label, toHHMM(r.start), toHHMM(r.end), r.kind]
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    logAudit(
      req.user, "created", "period", "School day",
      count + " classes of " + classMinutes + " min from " + startTime +
        (breaks.length ? ", " + breaks.length + " break(s)" : "")
    );

    const saved = await query("SELECT * FROM periods ORDER BY start_time");
    res.status(201).json(saved);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not build the school day." });
  }
});

router.delete("/periods/:id", allow("admin"), async function (req, res) {
  try {
    const used = await queryOne("SELECT id FROM timetable_slots WHERE period_id = $1 LIMIT 1", [req.params.id]);
    if (used) {
      return res.status(400).json({
        message: "This period is used in a class timetable. Clear those slots first, then delete it.",
      });
    }

    const row = await queryOne("DELETE FROM periods WHERE id = $1 RETURNING label", [req.params.id]);
    if (row) logAudit(req.user, "deleted", "period", row.label);
    res.json({ message: "Period removed." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not delete the period." });
  }
});

// ------------------------------------------------------------------
// ONE CLASS'S GRID
// ------------------------------------------------------------------

// Builds { periods, days, slots, published } for one class + section.
async function buildGrid(classId, sectionId) {
  const periods = await query("SELECT * FROM periods ORDER BY start_time");

  const section = await queryOne(
    `SELECT sec.timetable_published, c.name AS class_name, sec.name AS section_name
       FROM sections sec JOIN classes c ON c.id = sec.class_id
      WHERE sec.id = $1 AND sec.class_id = $2`,
    [sectionId, classId]
  );

  const rows = await query(
    `SELECT tt.day_of_week, tt.period_id, tt.subject_id, tt.teacher_id,
            sub.name AS subject_name, u.full_name AS teacher_name
       FROM timetable_slots tt
       LEFT JOIN subjects sub ON sub.id = tt.subject_id
       LEFT JOIN teachers t   ON t.id = tt.teacher_id
       LEFT JOIN users u      ON u.id = t.user_id
      WHERE tt.class_id = $1 AND tt.section_id = $2`,
    [classId, sectionId]
  );

  const slots = {};
  rows.forEach(function (r) {
    slots[r.day_of_week + "-" + r.period_id] = {
      subject_id: r.subject_id,
      subject_name: r.subject_name,
      teacher_id: r.teacher_id,
      teacher_name: r.teacher_name,
    };
  });

  return {
    class_name: section ? section.class_name : null,
    section_name: section ? section.section_name : null,
    published: section ? section.timetable_published : false,
    periods: periods,
    days: schoolDays().map(function (d) { return { value: d, label: DAY_NAMES[d] }; }),
    slots: slots,
  };
}

// Who may see one class's timetable. Returns an error message, or null when
// the person is allowed. Admin: any class. Teacher: their own sections.
// Student: their own class. Parent: their own child's class.
async function classAccessError(req, classId, sectionId) {
  if (req.user.role === "teacher") {
    const ok = await teacherOwnsSection(req.user.id, classId, sectionId);
    if (!ok) return "You are not assigned to this section.";
  }

  if (req.user.role === "student") {
    const me = await getStudentOfUser(req.user.id);
    if (!me || me.class_id !== classId || me.section_id !== sectionId) return "That is not your class.";
  }

  if (req.user.role === "parent") {
    const studentId = Number(req.query.student_id);
    const ok = studentId && (await parentOwnsStudent(req.user.id, studentId));
    if (!ok) return "That is not your child.";
    const child = await queryOne("SELECT class_id, section_id FROM students WHERE id = $1", [studentId]);
    if (!child || child.class_id !== classId || child.section_id !== sectionId) return "That is not your child's class.";
  }

  return null;
}

// GET /api/timetable/class/:classId/:sectionId
router.get("/class/:classId/:sectionId", async function (req, res) {
  try {
    const classId = Number(req.params.classId);
    const sectionId = Number(req.params.sectionId);

    const denied = await classAccessError(req, classId, sectionId);
    if (denied) return res.status(403).json({ message: denied });

    const grid = await buildGrid(classId, sectionId);

    if (req.user.role !== "admin" && !grid.published) {
      return res.status(403).json({ message: "The school has not published this timetable yet." });
    }

    res.json(grid);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the timetable." });
  }
});

// ------------------------------------------------------------------
// WHO TEACHES WHAT, in one section - the single source of truth the
// timetable is built on.
//
// Each subject in a section has at most one teacher (the database
// guarantees it), decided on the Teachers page. The timetable does not
// get to disagree with that: picking a subject fixes the teacher, and
// picking a teacher narrows the subjects to the ones they teach here.
// The class teacher is also offered for periods with no subject (an
// assembly, a study period), since they may teach nothing else here.
// ------------------------------------------------------------------
async function sectionOptions(classId, sectionId) {
  const subjects = await query(
    `SELECT sub.id, sub.name, t.id AS teacher_id, u.full_name AS teacher_name
       FROM subjects sub
       LEFT JOIN teacher_classes tc
              ON tc.subject_id = sub.id AND tc.class_id = $1 AND tc.section_id = $2
       LEFT JOIN teachers t ON t.id = tc.teacher_id
       LEFT JOIN users u    ON u.id = t.user_id
      WHERE sub.class_id = $1
      ORDER BY sub.name`,
    [classId, sectionId]
  );

  const teachers = await query(
    `SELECT t.id, u.full_name AS name
       FROM teachers t JOIN users u ON u.id = t.user_id
      WHERE t.id IN (SELECT teacher_id FROM teacher_classes WHERE class_id = $1 AND section_id = $2)
         OR t.id IN (SELECT class_teacher_id FROM sections WHERE id = $2 AND class_teacher_id IS NOT NULL)
      ORDER BY u.full_name`,
    [classId, sectionId]
  );

  teachers.forEach(function (t) {
    t.subject_ids = subjects
      .filter(function (s) { return s.teacher_id === t.id; })
      .map(function (s) { return s.id; });
  });

  return { subjects: subjects, teachers: teachers };
}

// GET /api/timetable/options/:classId/:sectionId   (admin)
router.get("/options/:classId/:sectionId", allow("admin"), async function (req, res) {
  try {
    res.json(await sectionOptions(Number(req.params.classId), Number(req.params.sectionId)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the subjects and teachers." });
  }
});

// PUT /api/timetable/class/:classId/:sectionId/slot
// { day_of_week, period_id, subject_id, teacher_id }
// Sending both subject_id and teacher_id as empty clears the cell.
router.put("/class/:classId/:sectionId/slot", allow("admin"), async function (req, res) {
  try {
    const classId = Number(req.params.classId);
    const sectionId = Number(req.params.sectionId);
    const { day_of_week, period_id } = req.body;
    let subjectId = req.body.subject_id ? Number(req.body.subject_id) : null;
    let teacherId = req.body.teacher_id ? Number(req.body.teacher_id) : null;

    if (day_of_week === undefined || !period_id) {
      return res.status(400).json({ message: "Choose a day and a period." });
    }

    const place = await queryOne(
      `SELECT c.name AS class_name, sec.name AS section_name, p.label AS period_label, p.kind AS period_kind
         FROM classes c, sections sec, periods p
        WHERE c.id = $1 AND sec.id = $2 AND p.id = $3`,
      [classId, sectionId, period_id]
    );
    if (place && place.period_kind === "break") {
      return res.status(400).json({ message: "That is a break, so no class can be placed in it." });
    }
    const where = place ? place.class_name + " - Section " + place.section_name : "a section";
    const when = DAY_NAMES[day_of_week] + ", " + (place ? place.period_label : "a period");

    // An empty cell is simply no row, so clearing just deletes it.
    if (!subjectId && !teacherId) {
      await query(
        "DELETE FROM timetable_slots WHERE class_id=$1 AND section_id=$2 AND day_of_week=$3 AND period_id=$4",
        [classId, sectionId, day_of_week, period_id]
      );
      res.json({ message: "Slot cleared." });
      logAudit(req.user, "updated", "timetable", where, when + ": cleared");
      return;
    }

    // Keep subject and teacher consistent with who really teaches what here.
    const options = await sectionOptions(classId, sectionId);
    let subjectName = null;
    let teacherName = null;

    if (subjectId) {
      const subject = options.subjects.find(function (x) { return x.id === subjectId; });

      if (!subject) {
        return res.status(400).json({ message: "That subject doesn't belong to this class." });
      }
      if (!subject.teacher_id) {
        return res.status(400).json({
          message:
            "No teacher is assigned to " + subject.name + " in " + where + " yet. " +
            "Assign one from the Teachers page first, then come back to the timetable.",
        });
      }
      if (teacherId && teacherId !== subject.teacher_id) {
        return res.status(400).json({
          message:
            subject.name + " in " + where + " is taught by " + subject.teacher_name +
            ", so nobody else can be placed on it. Change who teaches it from the Teachers page if that's wrong.",
        });
      }

      // One teacher per subject per section: the subject decides the teacher.
      teacherId = subject.teacher_id;
      subjectName = subject.name;
      teacherName = subject.teacher_name;
    } else {
      const teacher = options.teachers.find(function (x) { return x.id === teacherId; });
      if (!teacher) {
        return res.status(400).json({
          message: "That teacher isn't assigned to " + where + ". Assign them from the Teachers page first.",
        });
      }
      teacherName = teacher.name;
    }

    // A teacher cannot be in two places in the same period on the same day.
    const clash = await queryOne(
      `SELECT c.name AS class_name, sec.name AS section_name, p.label AS period_label
         FROM timetable_slots tt
         JOIN classes c    ON c.id = tt.class_id
         JOIN sections sec ON sec.id = tt.section_id
         JOIN periods p    ON p.id = tt.period_id
        WHERE tt.teacher_id = $1 AND tt.day_of_week = $2 AND tt.period_id = $3
          AND NOT (tt.class_id = $4 AND tt.section_id = $5)`,
      [teacherId, day_of_week, period_id, classId, sectionId]
    );

    if (clash) {
      return res.status(400).json({
        message:
          teacherName + " is already teaching " + clash.class_name + " - Section " + clash.section_name +
          " on " + DAY_NAMES[day_of_week] + " in " + clash.period_label +
          ". Choose a different period, or a different subject.",
      });
    }

    await query(
      `INSERT INTO timetable_slots (class_id, section_id, day_of_week, period_id, subject_id, teacher_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (class_id, section_id, day_of_week, period_id)
       DO UPDATE SET subject_id = EXCLUDED.subject_id, teacher_id = EXCLUDED.teacher_id`,
      [classId, sectionId, day_of_week, period_id, subjectId, teacherId]
    );

    res.json({ message: "Saved." });

    logAudit(
      req.user, "updated", "timetable", where,
      when + ": " + (subjectName || "no subject") + " with " + teacherName
    );
  } catch (err) {
    // A second safety net: if two admins save the same clash at the exact
    // same moment, the database itself refuses it.
    if (err.code === "23505") {
      return res.status(400).json({
        message: "That teacher is already teaching another class in this period. Choose someone else.",
      });
    }
    console.error(err);
    res.status(500).json({ message: "Could not save that slot." });
  }
});

// PUT /api/timetable/class/:classId/:sectionId/publish   { published: true|false }
router.put("/class/:classId/:sectionId/publish", allow("admin"), async function (req, res) {
  try {
    const sectionId = Number(req.params.sectionId);
    const published = Boolean(req.body.published);

    const section = await queryOne(
      `SELECT sec.*, c.name AS class_name FROM sections sec
         JOIN classes c ON c.id = sec.class_id WHERE sec.id = $1`,
      [sectionId]
    );
    if (!section) return res.status(404).json({ message: "Section not found." });

    await query("UPDATE sections SET timetable_published = $1 WHERE id = $2", [published, sectionId]);

    const label = section.class_name + " - Section " + section.name;
    logAudit(req.user, published ? "published" : "unpublished", "timetable", label);

    res.json({
      message: published
        ? "Published. Teachers, students and parents in " + label + " can now see it."
        : "Unpublished. Only you can see this timetable now.",
      published: published,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not change the timetable's status." });
  }
});

// ------------------------------------------------------------------
// GET /api/timetable/my   (teacher) - their own personal weekly schedule,
// assembled from every published section they have a slot in.
// ------------------------------------------------------------------
// A teacher's personal grid, shared by the screen and the PDF.
async function buildTeacherGrid(userId) {
  const teacher = await getTeacherOfUser(userId);
  if (!teacher) return { periods: [], days: [], slots: {} };

  const periods = await query("SELECT * FROM periods ORDER BY start_time");

  const rows = await query(
    `SELECT tt.day_of_week, tt.period_id, sub.name AS subject_name,
            c.name AS class_name, sec.name AS section_name
       FROM timetable_slots tt
       JOIN sections sec ON sec.id = tt.section_id
       JOIN classes c    ON c.id = tt.class_id
       LEFT JOIN subjects sub ON sub.id = tt.subject_id
      WHERE tt.teacher_id = $1 AND sec.timetable_published = TRUE`,
    [teacher.id]
  );

  const slots = {};
  rows.forEach(function (r) {
    slots[r.day_of_week + "-" + r.period_id] = {
      subject_name: r.subject_name,
      class_name: r.class_name,
      section_name: r.section_name,
    };
  });

  return {
    periods: periods,
    days: schoolDays().map(function (d) { return { value: d, label: DAY_NAMES[d] }; }),
    slots: slots,
  };
}

router.get("/my", allow("teacher"), async function (req, res) {
  try {
    res.json(await buildTeacherGrid(req.user.id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load your timetable." });
  }
});

// ------------------------------------------------------------------
// PDF DOWNLOADS
//   GET /api/timetable/pdf/class/:classId/:sectionId   one class
//        admin: any class. teacher: own sections. student / parent: their
//        own class only (parents pass ?student_id=). Non-admins only get
//        a timetable that has been published.
//   GET /api/timetable/pdf/all                          admin: every class
//        with a timetable (optionally ?class_id= for one whole class)
//   GET /api/timetable/pdf/my                           teacher: own timetable
// ------------------------------------------------------------------
function classPage(grid) {
  return {
    title: grid.class_name + " - Section " + grid.section_name,
    subtitle: "Weekly timetable",
    periods: grid.periods,
    days: grid.days,
    slots: grid.slots,
    cellLines: function (cell) {
      return [cell.subject_name || "General", cell.teacher_name || "No teacher"];
    },
  };
}

router.get("/pdf/class/:classId/:sectionId", async function (req, res) {
  try {
    if (req.user.role === "teacher") {
      // Teachers download their own personal timetable (/pdf/my) instead.
      return res.status(403).json({ message: "Download your own timetable instead." });
    }

    const classId = Number(req.params.classId);
    const sectionId = Number(req.params.sectionId);

    const denied = await classAccessError(req, classId, sectionId);
    if (denied) return res.status(403).json({ message: denied });

    const grid = await buildGrid(classId, sectionId);
    if (!grid.class_name) return res.status(404).json({ message: "Class not found." });

    if (req.user.role !== "admin" && !grid.published) {
      return res.status(403).json({ message: "The school has not published this timetable yet." });
    }

    const doc = newDocument();
    addTimetablePage(doc, classPage(grid));
    sendPdf(res, doc, "timetable-" + grid.class_name + "-" + grid.section_name + ".pdf");
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ message: "Could not create the PDF." });
  }
});

router.get("/pdf/all", allow("admin"), async function (req, res) {
  try {
    const classId = req.query.class_id ? Number(req.query.class_id) : null;

    const sections = await query(
      `SELECT sec.id AS section_id, sec.class_id
         FROM sections sec JOIN classes c ON c.id = sec.class_id
        WHERE ($1::int IS NULL OR sec.class_id = $1)
          AND EXISTS (SELECT 1 FROM timetable_slots t WHERE t.section_id = sec.id)
        ORDER BY c.name, sec.name`,
      [classId]
    );

    if (sections.length === 0) {
      return res.status(404).json({ message: "No class has a timetable to download yet." });
    }

    const doc = newDocument();
    for (const s of sections) {
      addTimetablePage(doc, classPage(await buildGrid(s.class_id, s.section_id)));
    }
    sendPdf(res, doc, classId ? "timetables-class.pdf" : "timetables-all-classes.pdf");
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ message: "Could not create the PDF." });
  }
});

router.get("/pdf/my", allow("teacher"), async function (req, res) {
  try {
    const grid = await buildTeacherGrid(req.user.id);
    if (Object.keys(grid.slots).length === 0) {
      return res.status(404).json({ message: "You have no published timetable to download yet." });
    }

    const doc = newDocument();
    addTimetablePage(doc, {
      title: req.user.name + " - Timetable",
      subtitle: "Weekly timetable",
      periods: grid.periods,
      days: grid.days,
      slots: grid.slots,
      cellLines: function (cell) {
        return [cell.class_name + " - " + cell.section_name, cell.subject_name || "General"];
      },
    });
    sendPdf(res, doc, "my-timetable.pdf");
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ message: "Could not create the PDF." });
  }
});

module.exports = router;
