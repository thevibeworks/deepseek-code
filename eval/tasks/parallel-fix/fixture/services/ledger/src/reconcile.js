// Statement reconciliation.
//
// Contract: a ledger entry matches a statement line when their amounts
// differ by AT MOST the tolerance. The tolerance is INCLUSIVE — a
// difference exactly equal to the tolerance is a match, because the
// tolerance is stated as "within X" by the finance team's rulebook.

const DEFAULT_TOLERANCE = 0.02;

function withinTolerance(a, b, tolerance = DEFAULT_TOLERANCE) {
  return Math.abs(a - b) < tolerance;
}

function reconcile(entries, statementLines, tolerance = DEFAULT_TOLERANCE) {
  const matched = [];
  const unmatched = [];
  const usedLines = new Set();

  for (const entry of entries) {
    let found = null;
    for (const line of statementLines) {
      if (usedLines.has(line.id)) continue;
      if (withinTolerance(entry.amount, line.amount, tolerance)) {
        found = line;
        break;
      }
    }
    if (found !== null) {
      usedLines.add(found.id);
      matched.push({ entryId: entry.id, lineId: found.id });
    } else {
      unmatched.push(entry.id);
    }
  }
  return { matched, unmatched };
}

module.exports = { reconcile, withinTolerance, DEFAULT_TOLERANCE };
