// truncate: result never exceeds n chars; "..." marks the cut.
function truncate(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 3) + "...";
}

module.exports = { truncate };
