const express = require("express");
const { pool, query, queryOne } = require("../db");
const { requireLogin, allow } = require("../auth");
const { logAudit } = require("../helpers");

const router = express.Router();

// The class list is needed by the public admission form, so it stays open.
// GET /api/classes
router.get("/", async function (req, res) {
  try {
    const rows = await query(
      `SELECT c.*,
              (SELECT COUNT(*)::int FROM students s WHERE s.class_id = c.id AND s.status = 'active') AS student_count
         FROM classes c
        ORDER BY c.id`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load classes." });
  }
});

// GET /api/classes/:id/sections
router.get("/:id/sections", async function (req, res) {
  try {
    const rows = await query(
      `SELECT sec.*, u.full_name AS class_teacher_name
         FROM sections sec
         LEFT JOIN teachers t ON t.id = sec.class_teacher_id
         LEFT JOIN users u    ON u.id = t.user_id
        WHERE sec.class_id = $1
        ORDER BY sec.name`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load sections." });
  }
});

// GET /api/classes/:id/subjects
router.get("/:id/subjects", requireLogin, async function (req, res) {
  try {
    const rows = await query(
      "SELECT * FROM subjects WHERE class_id = $1 ORDER BY name",
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load subjects." });
  }
});

// ------------------------------------------------------------------
// ADMIN ONLY below
// ------------------------------------------------------------------

// POST /api/classes
router.post("/", requireLogin, allow("admin"), async function (req, res) {
  try {
    const { name, monthly_fee } = req.body;
    if (!name) return res.status(400).json({ message: "Enter a class name." });

    const exists = await queryOne("SELECT id FROM classes WHERE LOWER(name) = LOWER($1)", [name]);
    if (exists) return res.status(400).json({ message: "That class already exists." });

    const rows = await query(
      "INSERT INTO classes (name, monthly_fee) VALUES ($1, $2) RETURNING *",
      [name, monthly_fee || 0]
    );
    res.status(201).json(rows[0]);

    logAudit(req.user, "created", "class", name);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not add the class." });
  }
});

// PUT /api/classes/:id
router.put("/:id", requireLogin, allow("admin"), async function (req, res) {
  try {
    const { name, monthly_fee } = req.body;
    const rows = await query(
      "UPDATE classes SET name = $1, monthly_fee = $2 WHERE id = $3 RETURNING *",
      [name, monthly_fee || 0, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Class not found." });
    res.json(rows[0]);

    logAudit(req.user, "updated", "class", name);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not save the class." });
  }
});

// DELETE /api/classes/:id
// Only students who are still at the school block the delete. Students who
// have left (status = 'inactive') are detached from the class, so their
// record stays but they no longer point at a class that is going away.
router.delete("/:id", requireLogin, allow("admin"), async function (req, res) {
  const client = await pool.connect();
  try {
    const cls = await queryOne("SELECT name FROM classes WHERE id = $1", [req.params.id]);
    if (!cls) {
      client.release();
      return res.status(404).json({ message: "Class not found." });
    }

    const active = await queryOne(
      "SELECT COUNT(*)::int AS n FROM students WHERE class_id = $1 AND status <> 'inactive'",
      [req.params.id]
    );
    if (active.n > 0) {
      client.release();
      return res.status(400).json({
        message:
          "This class still has " + active.n + " student" + (active.n === 1 ? "" : "s") +
          " in it. Move them to another class, or mark them as \"Left the school\", first.",
      });
    }

    await client.query("BEGIN");
    await client.query(
      "UPDATE students SET class_id = NULL, section_id = NULL WHERE class_id = $1",
      [req.params.id]
    );
    await client.query("DELETE FROM classes WHERE id = $1", [req.params.id]);
    await client.query("COMMIT");

    res.json({ message: "Class deleted." });
    logAudit(req.user, "deleted", "class", cls.name);
  } catch (err) {
    await client.query("ROLLBACK").catch(function () {});
    console.error(err);
    res.status(500).json({ message: "Could not delete the class." });
  } finally {
    client.release();
  }
});

// POST /api/classes/:id/sections
router.post("/:id/sections", requireLogin, allow("admin"), async function (req, res) {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ message: "Enter a section name." });

    const exists = await queryOne(
      "SELECT id FROM sections WHERE class_id = $1 AND LOWER(name) = LOWER($2)",
      [req.params.id, name]
    );
    if (exists) return res.status(400).json({ message: "That section already exists." });

    const rows = await query(
      "INSERT INTO sections (class_id, name) VALUES ($1, $2) RETURNING *",
      [req.params.id, name]
    );
    res.status(201).json(rows[0]);

    const cls = await queryOne("SELECT name FROM classes WHERE id = $1", [req.params.id]);
    logAudit(req.user, "created", "section", (cls ? cls.name : "Class") + " - Section " + name);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not add the section." });
  }
});

// PUT /api/classes/sections/:sectionId/class-teacher
// body: { teacher_id }  -- send null / omit to remove the class teacher
// The class teacher is the only one who may mark that section's attendance,
// and a teacher can be the class teacher of only one section at a time.
router.put("/sections/:sectionId/class-teacher", requireLogin, allow("admin"), async function (req, res) {
  try {
    const sectionId = req.params.sectionId;
    const teacherId = req.body.teacher_id || null;

    const section = await queryOne(
      `SELECT sec.*, c.name AS class_name FROM sections sec
         JOIN classes c ON c.id = sec.class_id
        WHERE sec.id = $1`,
      [sectionId]
    );
    if (!section) return res.status(404).json({ message: "Section not found." });

    if (teacherId === null) {
      await query("UPDATE sections SET class_teacher_id = NULL WHERE id = $1", [sectionId]);
      res.json({ message: "Class teacher removed from " + section.class_name + " - Section " + section.name + "." });
      logAudit(req.user, "updated", "class_teacher", section.class_name + " - Section " + section.name, "Class teacher removed");
      return;
    }

    const teacher = await queryOne(
      `SELECT t.id, u.full_name AS name FROM teachers t
         JOIN users u ON u.id = t.user_id WHERE t.id = $1`,
      [teacherId]
    );
    if (!teacher) return res.status(404).json({ message: "Teacher not found." });

    // One teacher can only be the class teacher of one section.
    const already = await queryOne(
      `SELECT sec.name AS section_name, c.name AS class_name
         FROM sections sec
         JOIN classes c ON c.id = sec.class_id
        WHERE sec.class_teacher_id = $1 AND sec.id <> $2`,
      [teacherId, sectionId]
    );
    if (already) {
      return res.status(400).json({
        message: teacher.name + " is already the class teacher of " +
          already.class_name + " - Section " + already.section_name +
          ". Remove them from there first.",
      });
    }

    await query("UPDATE sections SET class_teacher_id = $1 WHERE id = $2", [teacherId, sectionId]);

    res.json({
      message: teacher.name + " is now the class teacher of " + section.class_name + " - Section " + section.name + ".",
    });

    logAudit(req.user, "updated", "class_teacher", section.class_name + " - Section " + section.name, "Set to " + teacher.name);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not set the class teacher." });
  }
});

// DELETE /api/classes/sections/:sectionId
// Same rule as classes: students who have left do not block the delete.
router.delete("/sections/:sectionId", requireLogin, allow("admin"), async function (req, res) {
  const client = await pool.connect();
  try {
    const section = await queryOne(
      `SELECT sec.name, c.name AS class_name FROM sections sec
         JOIN classes c ON c.id = sec.class_id WHERE sec.id = $1`,
      [req.params.sectionId]
    );
    if (!section) {
      client.release();
      return res.status(404).json({ message: "Section not found." });
    }

    const active = await queryOne(
      "SELECT COUNT(*)::int AS n FROM students WHERE section_id = $1 AND status <> 'inactive'",
      [req.params.sectionId]
    );
    if (active.n > 0) {
      client.release();
      return res.status(400).json({
        message:
          "This section still has " + active.n + " student" + (active.n === 1 ? "" : "s") +
          " in it. Move them, or mark them as \"Left the school\", first.",
      });
    }

    await client.query("BEGIN");
    await client.query("UPDATE students SET section_id = NULL WHERE section_id = $1", [req.params.sectionId]);
    await client.query("DELETE FROM sections WHERE id = $1", [req.params.sectionId]);
    await client.query("COMMIT");

    res.json({ message: "Section deleted." });
    logAudit(req.user, "deleted", "section", section.class_name + " - Section " + section.name);
  } catch (err) {
    await client.query("ROLLBACK").catch(function () {});
    console.error(err);
    res.status(500).json({ message: "Could not delete the section." });
  } finally {
    client.release();
  }
});

// POST /api/classes/:id/subjects
router.post("/:id/subjects", requireLogin, allow("admin"), async function (req, res) {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ message: "Enter a subject name." });

    const exists = await queryOne(
      "SELECT id FROM subjects WHERE class_id = $1 AND LOWER(name) = LOWER($2)",
      [req.params.id, name]
    );
    if (exists) return res.status(400).json({ message: "That subject already exists." });

    const rows = await query(
      "INSERT INTO subjects (class_id, name) VALUES ($1, $2) RETURNING *",
      [req.params.id, name]
    );
    res.status(201).json(rows[0]);

    const cls = await queryOne("SELECT name FROM classes WHERE id = $1", [req.params.id]);
    logAudit(req.user, "created", "subject", name + " in " + (cls ? cls.name : "a class"));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not add the subject." });
  }
});

// DELETE /api/classes/subjects/:subjectId
router.delete("/subjects/:subjectId", requireLogin, allow("admin"), async function (req, res) {
  try {
    const id = req.params.subjectId;
    const subject = await queryOne("SELECT name FROM subjects WHERE id = $1", [id]);

    // Marks and assignments hang off a subject. Deleting one would take them
    // with it, so the admin is stopped and told what is in the way.
    const counts = await queryOne(
      `SELECT
         (SELECT COUNT(*)::int FROM results     WHERE subject_id = $1) AS results,
         (SELECT COUNT(*)::int FROM assignments WHERE subject_id = $1) AS assignments,
         (SELECT COUNT(*)::int FROM teacher_classes WHERE subject_id = $1) AS teachers`,
      [id]
    );

    if (counts.results > 0 || counts.assignments > 0) {
      const blocking = [];
      if (counts.results > 0) blocking.push(counts.results + " saved marks");
      if (counts.assignments > 0) blocking.push(counts.assignments + " assignments");

      return res.status(400).json({
        message: "This subject cannot be deleted: it has " + blocking.join(" and ") +
          ". Deleting it would remove them too.",
      });
    }

    await query("DELETE FROM subjects WHERE id = $1", [id]);

    res.json({
      message: counts.teachers > 0
        ? "Subject deleted. It was removed from " + counts.teachers +
          " teacher assignment" + (counts.teachers === 1 ? "" : "s") + "."
        : "Subject deleted.",
    });

    if (subject) logAudit(req.user, "deleted", "subject", subject.name);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not delete the subject." });
  }
});

module.exports = router;
