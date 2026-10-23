// A read-only trail of who did what. The admin can look, filter and page
// through it, but there is deliberately no edit or delete endpoint here —
// an audit log that could be changed would not be worth much.
const express = require("express");
const { query, queryOne } = require("../db");
const { requireLogin, allow } = require("../auth");
const { logAudit } = require("../helpers");

const router = express.Router();
router.use(requireLogin, allow("admin"));

// GET /api/audit?entity=&role=&search=&from=&to=&page=1
router.get("/", async function (req, res) {
  try {
    const { entity, role, search, from, to } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = 25;

    const where = [];
    const values = [];

    function add(sql, value) {
      values.push(value);
      where.push(sql.replace("?", "$" + values.length));
    }

    if (entity) add("entity = ?", entity);
    if (role) add("user_role = ?", role);
    if (from) add("created_at >= ?", from + " 00:00:00");
    if (to) add("created_at <= ?", to + " 23:59:59");
    if (search) {
      values.push("%" + search + "%");
      where.push(
        "(label ILIKE $" + values.length + " OR details ILIKE $" + values.length +
        " OR user_name ILIKE $" + values.length + ")"
      );
    }

    const clause = where.length > 0 ? "WHERE " + where.join(" AND ") : "";

    const total = await queryOne("SELECT COUNT(*)::int AS total FROM audit_logs " + clause, values);

    values.push(perPage, (page - 1) * perPage);
    const rows = await query(
      `SELECT * FROM audit_logs ${clause}
        ORDER BY created_at DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );

    res.json({
      entries: rows,
      page: page,
      per_page: perPage,
      total: total.total,
      total_pages: Math.max(1, Math.ceil(total.total / perPage)),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the audit log." });
  }
});

// GET /api/audit/entities  -> the distinct entity types, to fill a filter
router.get("/entities", async function (req, res) {
  try {
    const rows = await query("SELECT DISTINCT entity FROM audit_logs ORDER BY entity");
    res.json(rows.map(function (r) { return r.entity; }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the filter list." });
  }
});

// There is no edit or delete here, and there never will be. Anything other
// than reading is refused, and the attempt itself goes on the record. (The
// database has triggers that refuse it too, as a second, independent lock.)
router.all("*", function (req, res, next) {
  if (req.method === "GET") return next();

  logAudit(
    req.user, "blocked", "audit_log",
    "Tried to " + req.method + " the audit log",
    req.method + " " + req.originalUrl.split("?")[0]
  );

  res.status(405).json({
    message: "The audit log is read-only. Entries cannot be edited or deleted by anyone.",
  });
});

module.exports = router;
