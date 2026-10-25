// Draws weekly timetables as PDF pages (A4, landscape) with PDFKit.
// One page per timetable. Breaks and lunch are drawn as a shaded row that
// runs across the whole day.
const PDFDocument = require("pdfkit");

const INK = "#0f172a";
const MUTED = "#64748b";
const LINE = "#cbd5e1";
const HEAD_BG = "#e2e8f0";
const BREAK_BG = "#fef3c7";
const BREAK_TEXT = "#b45309";

function to12Hour(hhmm) {
  const parts = String(hhmm).split(":");
  let hour = Number(parts[0]);
  const suffix = hour >= 12 ? "PM" : "AM";
  hour = hour % 12 || 12;
  return hour + ":" + parts[1] + " " + suffix;
}

function newDocument() {
  return new PDFDocument({ size: "A4", layout: "landscape", margin: 36, autoFirstPage: false });
}

// timetable = {
//   title, subtitle,
//   periods: [{ label, start_time, end_time, kind }],
//   days:    [{ value, label }],
//   slots:   { "day-periodId": cell },
//   cellLines(cell) -> [line1, line2]
// }
function addTimetablePage(doc, timetable) {
  doc.addPage();

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom - 18;

  // Heading
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(18).text(timetable.title, left, 36, { width: width });
  if (timetable.subtitle) {
    doc.fillColor(MUTED).font("Helvetica").fontSize(10).text(timetable.subtitle, left, doc.y + 2, { width: width });
  }

  const periods = timetable.periods;
  const days = timetable.days;

  if (periods.length === 0 || days.length === 0) {
    doc.fillColor(MUTED).fontSize(11).text("No periods have been set up yet.", left, doc.y + 20);
    return;
  }

  // Table geometry
  const top = doc.y + 12;
  const timeColW = 92;
  const dayColW = (width - timeColW) / days.length;
  const headH = 24;

  // Class rows count 1 unit and break rows 0.55, shrunk to fit one page.
  const units = periods.reduce(function (sum, p) { return sum + (p.kind === "break" ? 0.55 : 1); }, 0);
  const unit = Math.min(48, (bottom - top - headH) / units);

  // Header row
  doc.rect(left, top, width, headH).fill(HEAD_BG);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(9);
  doc.text("Period", left + 6, top + 8, { width: timeColW - 8 });
  days.forEach(function (d, i) {
    doc.text(d.label, left + timeColW + i * dayColW + 6, top + 8, { width: dayColW - 8 });
  });

  let y = top + headH;

  periods.forEach(function (p) {
    const isBreak = p.kind === "break";
    const h = unit * (isBreak ? 0.55 : 1);

    if (isBreak) doc.rect(left, y, width, h).fill(BREAK_BG);

    // Row border
    doc.lineWidth(0.5).strokeColor(LINE).rect(left, y, width, h).stroke();

    // Time column
    const small = Math.min(8, h / 2.4);
    doc.fillColor(isBreak ? BREAK_TEXT : INK).font("Helvetica-Bold").fontSize(Math.min(9, h / 2.2));
    const labelY = y + Math.max(2, (h - (isBreak ? 0 : small) - 10) / 2);
    doc.text(p.label, left + 6, labelY, { width: timeColW - 8, height: 12, ellipsis: true, lineBreak: false });
    if (!isBreak || h > 22) {
      doc.fillColor(MUTED).font("Helvetica").fontSize(small);
      doc.text(
        to12Hour(p.start_time) + " - " + to12Hour(p.end_time),
        left + 6, doc.y + 1, { width: timeColW - 8, lineBreak: false }
      );
    }

    if (isBreak) {
      doc.fillColor(BREAK_TEXT).font("Helvetica-Bold").fontSize(Math.min(10, h / 1.8));
      doc.text(p.label, left + timeColW, y + (h - 10) / 2, { width: width - timeColW, align: "center", lineBreak: false });
    } else {
      days.forEach(function (d, i) {
        const x = left + timeColW + i * dayColW;
        doc.lineWidth(0.5).strokeColor(LINE).moveTo(x, y).lineTo(x, y + h).stroke();

        const cell = timetable.slots[d.value + "-" + p.id];
        if (!cell) return;

        const lines = timetable.cellLines(cell);
        doc.fillColor(INK).font("Helvetica-Bold").fontSize(9);
        doc.text(lines[0], x + 6, y + 6, { width: dayColW - 10, height: 11, ellipsis: true, lineBreak: false });
        if (lines[1]) {
          doc.fillColor(MUTED).font("Helvetica").fontSize(8);
          doc.text(lines[1], x + 6, y + 19, { width: dayColW - 10, height: 10, ellipsis: true, lineBreak: false });
        }
      });
    }

    y += h;
  });

  // Footer
  doc.fillColor(MUTED).font("Helvetica").fontSize(8);
  doc.text("Generated on " + new Date().toLocaleDateString("en-GB"), left, doc.page.height - doc.page.margins.bottom - 12, {
    width: width, align: "right", lineBreak: false,
  });
}

// Streams the finished PDF to an Express response.
function sendPdf(res, doc, filename) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'attachment; filename="' + filename.replace(/[^a-zA-Z0-9._-]/g, "_") + '"');
  doc.pipe(res);
  doc.end();
}

module.exports = { newDocument, addTimetablePage, sendPdf };
