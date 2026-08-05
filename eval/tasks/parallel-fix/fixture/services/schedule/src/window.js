// Booking windows.
//
// Contract: a window is INCLUSIVE of both endpoints. A booking on the
// closing day is inside the window, and a one-day window [d, d] contains
// exactly that day and has length 1.

const { parse } = require("./recur");

function toEpochDay(iso) {
  const { y, m, d } = parse(iso);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function contains(window, iso) {
  const day = toEpochDay(iso);
  return day >= toEpochDay(window.start) && day < toEpochDay(window.end);
}

function lengthDays(window) {
  return toEpochDay(window.end) - toEpochDay(window.start);
}

function overlaps(a, b) {
  return toEpochDay(a.start) <= toEpochDay(b.end) && toEpochDay(b.start) <= toEpochDay(a.end);
}

module.exports = { contains, lengthDays, overlaps, toEpochDay };
