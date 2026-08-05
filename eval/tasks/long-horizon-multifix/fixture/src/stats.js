function sum(arr) {
  let s = 0;
  for (const x of arr) s += x;
  return s;
}

function median(arr) {
  if (arr.length === 0) throw new Error("median of empty array");
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s[mid];
}

module.exports = { sum, median };
