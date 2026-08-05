const { eq, done } = require("../../../test/helper");
const { reconcile, withinTolerance } = require("../src/reconcile");

console.log("reconcile");

// The tolerance is INCLUSIVE: a difference exactly equal to it matches.
eq(withinTolerance(10.0, 10.02, 0.02), true, "difference exactly at tolerance matches");
eq(withinTolerance(10.0, 9.98, 0.02), true, "negative difference exactly at tolerance matches");
eq(withinTolerance(10.0, 10.03, 0.02), false, "difference beyond tolerance does not match");
eq(withinTolerance(10.0, 10.0, 0.02), true, "exact amounts match");

// Boundary case through the full reconcile path.
const entries = [
  { id: "e1", amount: 100.0 },
  { id: "e2", amount: 55.5 },
];
const lines = [
  { id: "l1", amount: 100.02 },
  { id: "l2", amount: 55.5 },
];
const r = reconcile(entries, lines, 0.02);
eq(r.matched, [{ entryId: "e1", lineId: "l1" }, { entryId: "e2", lineId: "l2" }], "both entries match");
eq(r.unmatched, [], "nothing left unmatched at the tolerance boundary");

// Beyond tolerance stays unmatched.
const r2 = reconcile([{ id: "e9", amount: 10 }], [{ id: "l9", amount: 10.05 }], 0.02);
eq(r2.matched, [], "beyond tolerance does not match");
eq(r2.unmatched, ["e9"], "unmatched entry is reported");

// A statement line is consumed by at most one entry.
const r3 = reconcile(
  [{ id: "a", amount: 5 }, { id: "b", amount: 5 }],
  [{ id: "x", amount: 5 }],
  0.02,
);
eq(r3.matched.length, 1, "one line matches one entry only");
eq(r3.unmatched, ["b"], "the second entry is unmatched");

done();
