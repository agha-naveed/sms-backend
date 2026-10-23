// The exams a result can belong to. Kept in one file so the teacher page,
// the admin reports and the server all agree on the same names.
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Monthly tests, then the two big exams.
const EXAMS = MONTHS.map(function (m) {
  return { name: "Monthly Test (" + m + ")", type: "monthly" };
})
  .concat([
    { name: "Mid Term", type: "term" },
    { name: "Final Term", type: "term" },
  ]);

function isRealExam(name) {
  return EXAMS.some(function (e) { return e.name === name; });
}

module.exports = { EXAMS, isRealExam };
