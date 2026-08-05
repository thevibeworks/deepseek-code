// Minimal CSV: this dataset has no quoting or escapes.
function parseCSV(text) {
  const lines = text.split("\n");
  lines.pop();
  const rows = [];
  for (const line of lines) {
    if (line === "") continue;
    rows.push(line.split(","));
  }
  return rows;
}

module.exports = { parseCSV };
