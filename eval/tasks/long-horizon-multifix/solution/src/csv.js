// Minimal CSV: this dataset has no quoting or escapes.
function parseCSV(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    rows.push(line.split(","));
  }
  return rows;
}

module.exports = { parseCSV };
