// Where the admin deals with "I forgot my password" requests.
//
// Approving is a security decision, not a formality: whoever is approved
// gets to choose a new password for that account. So the list shows what
// the admin needs to confirm it's really them - the phone number on file,
// the class, the child's or parent's name - and the approval is logged.
const express = require("express");
const { query, queryOne } = require("../db");
const { requireLogin, allow } = require("../auth");
const { logAudit } = require("../helpers");

const router = express.Router();
router.use(requireLogin, allow("admin"));

const APPROVAL_WINDOW_HOURS = 24;

async function expireOldRequests() {
  await query(
    `UPDATE password_reset_requests SET status = 'expired'
      WHERE (status = 'approved' AND expires_at < NOW())
         OR (status = 'pending' AND requested_at < NOW() - INTERVAL '7 days')`
  );
}

// GET /api/password-requests/count   -> for the badge in the menu
router.get("/count", async function (req, res) {
  try {
    await expireOldRequests();
    const row = await queryOne("SELECT COUNT(*)::int AS pending FROM password_reset_requests WHERE status = 'pending'");
    res.json({ pending: row.pending });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not count the requests." });
  }
});

// GET /api/password-requests
router.get("/", async function (req, res) {
  try {
    await expireOldRequests();

    const rows = await query(
      `SELECT r.id, r.status, r.requested_at, r.decided_at, r.expires_at, r.used_at, r.note,
              u.full_name AS name, u.email, u.role, u.phone,
              d.full_name AS decided_by_name,
              s.admission_no, c.name AS class_name, sec.name AS section_name,
              pu.full_name AS parent_name, pu.phone AS parent_phone,
              (SELECT string_agg(su.full_name || ' (' || st.admission_no || ')', ', ')
                 FROM parents p
                 JOIN students st ON st.parent_id = p.id
                 JOIN users su    ON su.id = st.user_id
                WHERE p.user_id = u.id) AS children
         FROM password_reset_requests r
         JOIN users u          ON u.id = r.user_id
         LEFT JOIN users d     ON d.id = r.decided_by
         LEFT JOIN students s  ON s.user_id = u.id
         LEFT JOIN classes c   ON c.id = s.class_id
         LEFT JOIN sections sec ON sec.id = s.section_id
         LEFT JOIN parents pa  ON pa.id = s.parent_id
         LEFT JOIN users pu    ON pu.id = pa.user_id
        ORDER BY (r.status = 'pending') DESC, r.requested_at DESC
        LIMIT 100`
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the requests." });
  }
});

// POST /api/password-requests/:id/approve
router.post("/:id/approve", async function (req, res) {
  try {
    const row = await queryOne(
      `SELECT r.*, u.full_name, u.role FROM password_reset_requests r
         JOIN users u ON u.id = r.user_id WHERE r.id = $1`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ message: "Request not found." });

    if (row.status !== "pending") {
      return res.status(400).json({ message: "This request has already been dealt with." });
    }

    const done = await query(
      `UPDATE password_reset_requests
          SET status = 'approved', decided_at = NOW(), decided_by = $1,
              expires_at = NOW() + INTERVAL '${APPROVAL_WINDOW_HOURS} hours'
        WHERE id = $2 AND status = 'pending' RETURNING id`,
      [req.user.id, row.id]
    );
    if (done.length === 0) {
      return res.status(400).json({ message: "This request has already been dealt with." });
    }

    res.json({
      message:
        "Approved. " + row.full_name + " can now choose a new password from the Forgot password page, " +
        "in the same browser they asked from. It stays open for " + APPROVAL_WINDOW_HOURS + " hours.",
    });

    logAudit(req.user, "approved", "password_request", row.full_name + " (" + row.role + ")", "Open for " + APPROVAL_WINDOW_HOURS + " hours");
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not approve the request." });
  }
});

// POST /api/password-requests/:id/reject   { note }
// Also how the admin cancels a request the person can no longer finish
// (for instance, they closed the page), so they can start again.
router.post("/:id/reject", async function (req, res) {
  try {
    const row = await queryOne(
      `SELECT r.*, u.full_name, u.role FROM password_reset_requests r
         JOIN users u ON u.id = r.user_id WHERE r.id = $1`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ message: "Request not found." });

    if (row.status !== "pending" && row.status !== "approved") {
      return res.status(400).json({ message: "This request has already been dealt with." });
    }

    const note = (req.body.note || "").trim() || null;

    await query(
      `UPDATE password_reset_requests
          SET status = 'rejected', decided_at = NOW(), decided_by = $1, note = $2
        WHERE id = $3 AND status IN ('pending','approved')`,
      [req.user.id, note, row.id]
    );

    res.json({ message: "Request rejected." });

    logAudit(req.user, "rejected", "password_request", row.full_name + " (" + row.role + ")", note);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not reject the request." });
  }
});

module.exports = router;
