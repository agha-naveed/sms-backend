// School Management System - server entry point
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const { pool } = require("./db");

const app = express();

app.use(cors());
app.use(express.json());
app.use(require("./auditTrail")); // safety net: no change goes unrecorded

// Uploaded files (photos, admission documents, assignment files) are served
// from here, e.g. http://localhost:5000/uploads/1725600000-12345.pdf
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ---- routes ----
app.use("/api/auth", require("./routes/auth"));
app.use("/api/admissions", require("./routes/admissions"));
app.use("/api/classes", require("./routes/classes"));
app.use("/api/students", require("./routes/students"));
app.use("/api/teachers", require("./routes/teachers"));
app.use("/api/parents", require("./routes/parents"));
app.use("/api/attendance", require("./routes/attendance"));
app.use("/api/assignments", require("./routes/assignments"));
app.use("/api/results", require("./routes/results"));
app.use("/api/fees", require("./routes/fees"));
app.use("/api/notices", require("./routes/notices"));
app.use("/api/notifications", require("./routes/notifications"));
app.use("/api/dashboard", require("./routes/dashboard"));
app.use("/api/settings", require("./routes/settings"));
app.use("/api/audit", require("./routes/audit"));
app.use("/api/teacher-attendance", require("./routes/teacherAttendance"));
app.use("/api/timetable", require("./routes/timetable"));
app.use("/api/password-requests", require("./routes/passwordRequests"));
app.use("/api/files", require("./routes/files"));

app.get("/api/health", function (req, res) {
  res.json({ ok: true, time: new Date() });
});

// ---- error handling ----
// Multer sends its errors here (file too big, wrong type).
app.use(function (err, req, res, next) {
  console.error(err.message);
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ message: "That file is larger than 5 MB." });
  }
  res.status(400).json({ message: err.message || "Something went wrong." });
});

app.use(function (req, res) {
  res.status(404).json({ message: "That address does not exist on the server." });
});

const PORT = process.env.PORT || 5000;

pool
  .query("SELECT 1")
  .then(function () {
    app.listen(PORT, function () {
      console.log("Database connected.");
      console.log("Server running on http://localhost:" + PORT);
    });
  })
  .catch(function (err) {
    console.error("Could not connect to PostgreSQL.");
    console.error("Check the DB settings in your .env file.");
    console.error(err.message);
    process.exit(1);
  });
