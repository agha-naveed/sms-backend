// Runs once at start-up. Every statement is "IF NOT EXISTS" / "OR REPLACE",
// so it is safe to run every time the server starts.
const { pool } = require("./db");

async function migrate() {
  // Date ranges the school is closed: a holiday, a vacation, a local holiday.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS school_holidays (
      id         SERIAL PRIMARY KEY,
      kind       VARCHAR(20) NOT NULL,
      title      VARCHAR(120) NOT NULL,
      start_date DATE NOT NULL,
      end_date   DATE NOT NULL,
      note       TEXT,
      created_by INTEGER,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CHECK (end_date >= start_date)
    )
  `);

  // Which weekdays the school is always closed: none, saturday, sunday, both.
  await pool.query(
    "ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS weekly_off VARCHAR(20) NOT NULL DEFAULT 'sunday'"
  );

  // One place that answers "is the school closed on this date?", so every
  // report (parent, student, teacher, admin) leaves those days out the same way.
  await pool.query(`
    CREATE OR REPLACE FUNCTION is_school_holiday(d date) RETURNS boolean AS $$
      SELECT EXISTS (SELECT 1 FROM school_holidays h WHERE d BETWEEN h.start_date AND h.end_date)
          OR (CASE COALESCE((SELECT weekly_off FROM school_settings ORDER BY id LIMIT 1), 'sunday')
                WHEN 'sunday'   THEN EXTRACT(DOW FROM d) = 0
                WHEN 'saturday' THEN EXTRACT(DOW FROM d) = 6
                WHEN 'both'     THEN EXTRACT(DOW FROM d) IN (0, 6)
                ELSE FALSE
              END)
    $$ LANGUAGE sql STABLE
  `);
}

module.exports = migrate;
