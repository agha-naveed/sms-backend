// Database connection. One pool is shared by the whole app.
require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// Small helper so routes can just write:  const rows = await query(sql, [a, b])
// Values always go in the second argument, never glued into the SQL string.
// That is what stops SQL injection.
async function query(sql, values) {
  const result = await pool.query(sql, values || []);
  return result.rows;
}

// Same thing but returns only the first row (or undefined).
async function queryOne(sql, values) {
  const rows = await query(sql, values);
  return rows[0];
}

module.exports = { pool, query, queryOne };
