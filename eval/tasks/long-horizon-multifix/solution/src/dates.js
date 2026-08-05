const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// iso: "YYYY-MM-DD" or a full timestamp; only the date part is used.
function dayName(iso) {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  return DAY_NAMES[new Date(y, m - 1, d).getDay()];
}

module.exports = { dayName, DAY_NAMES };
