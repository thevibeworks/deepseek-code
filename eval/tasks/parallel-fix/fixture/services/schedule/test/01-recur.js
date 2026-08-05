const { eq, done } = require("../../../test/helper");
const { monthlySeries, addMonths } = require("../src/recur");

console.log("recur");

// Ordinary anchors are boring.
eq(monthlySeries("2026-01-15", 3), ["2026-01-15", "2026-02-15", "2026-03-15"], "15th anchor");

// Short months CLAMP; they must not spill into the next month.
eq(addMonths("2026-01-31", 1), "2026-02-28", "31 Jan + 1 month -> 28 Feb (not 3 Mar)");
eq(addMonths("2026-03-31", 1), "2026-04-30", "31 Mar + 1 month -> 30 Apr");

// A short month must not permanently shift the anchor.
eq(
  monthlySeries("2026-01-31", 4),
  ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"],
  "31st anchor returns to 31 in March",
);

// Leap years.
eq(addMonths("2028-01-31", 1), "2028-02-29", "leap year Feb clamps to 29");

// Year rollover.
eq(addMonths("2026-11-30", 2), "2027-01-30", "crosses the year boundary");
eq(addMonths("2026-12-31", 2), "2027-02-28", "Dec 31 + 2 months -> Feb 28");

done();
