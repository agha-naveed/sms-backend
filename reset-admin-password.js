// If the admin forgets their password, there is no one above them in the
// system to reset it - the same "break glass" situation every self-hosted
// system eventually runs into (it's exactly how, say, a forgotten
// WordPress admin password gets fixed too: whoever has direct access to
// the server and database runs a command).
//
// Usage, from the server folder:
//   node reset-admin-password.js newpassword123
//
// Whoever can run this already has full access to the server and the
// database, so this script does not need its own login of any kind.
require("dotenv").config();
const { hashPassword } = require("./auth");
const { pool } = require("./db");

async function main() {
  const newPassword = process.argv[2];

  if (!newPassword || newPassword.length < 6) {
    console.log("Usage: node reset-admin-password.js <new-password>");
    console.log("The new password must be at least 6 characters.");
    process.exit(1);
  }

  const result = await pool.query(
    "UPDATE users SET password = $1 WHERE role = 'admin' RETURNING email, full_name",
    [hashPassword(newPassword)]
  );

  if (result.rows.length === 0) {
    console.log("No admin account was found. Run the seed script first: npm run seed");
  } else {
    result.rows.forEach(function (u) {
      console.log("Password updated for " + u.full_name + " (" + u.email + ").");
    });
  }

  await pool.end();
}

main().catch(function (err) {
  console.error("Could not reset the password:", err.message);
  process.exit(1);
});
