// The audit log is only worth trusting if nothing can slip past it.
//
// Every route that changes something records a readable entry itself
// (see logAudit in helpers.js). This middleware is the safety net behind
// that: if a signed-in person's request changed something (POST, PUT,
// PATCH or DELETE, and it succeeded) and no route wrote an entry for it,
// a plain one is written here. So even a route added next year, by
// someone who forgets to call logAudit, is still on the record.
//
// Requests from people who are not signed in (the public admission form,
// sign-in attempts, password requests) are logged explicitly by their own
// routes, since there is no user to attribute them to here.
const { logAudit } = require("./helpers");

const CHANGING = ["POST", "PUT", "PATCH", "DELETE"];

function auditTrail(req, res, next) {
  if (CHANGING.includes(req.method)) {
    res.on("finish", function () {
      if (res.statusCode >= 400) return;

      // Give the route a moment to finish its own logAudit call, which many
      // routes make just after sending their reply.
      setTimeout(function () {
        if (!req.user || req.user._audited) return;

        const path = req.originalUrl.split("?")[0];
        const entity = (path.split("/")[2] || "system").replace(/-/g, "_");

        logAudit(
          req.user, "changed", entity,
          req.method + " " + path,
          "Recorded automatically (HTTP " + res.statusCode + ")"
        );
      }, 750);
    });
  }

  next();
}

module.exports = auditTrail;
