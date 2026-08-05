// Monthly recurrence.
//
// Contract: a monthly series anchored on day N lands on day N of each
// following month, and CLAMPS to the last day of months that are too
// short. A series anchored on the 31st goes 31 Jan -> 28 Feb (29 in a
// leap year) -> 31 Mar. It must never spill into the following month,
// and a short month must not permanently shift the anchor: the 31st
// anchor returns to 31 in March.
//
// All dates are UTC calendar dates, "YYYY-MM-DD".

function parse(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function format({ y, m, d }) {
  return `${y}-${pad(m)}-${pad(d)}`;
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addMonths(iso, count) {
  const { y, m, d } = parse(iso);
  const total = (y * 12 + (m - 1)) + count;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return format({ y: ny, m: nm, d });
}

function monthlySeries(startIso, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(addMonths(startIso, i));
  return out;
}

module.exports = { monthlySeries, addMonths, daysInMonth, parse, format };
