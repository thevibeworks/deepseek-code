const { eq, done } = require("../../../test/helper");
const { contains, lengthDays, overlaps } = require("../src/window");

console.log("window");

const w = { start: "2026-03-01", end: "2026-03-05" };

eq(contains(w, "2026-03-01"), true, "opening day is inside");
eq(contains(w, "2026-03-03"), true, "middle day is inside");

// The closing day is INSIDE. This is the contract the booking desk relies on.
eq(contains(w, "2026-03-05"), true, "closing day is inside (inclusive)");
eq(contains(w, "2026-03-06"), false, "day after the close is outside");
eq(contains(w, "2026-02-28"), false, "day before the open is outside");

// Inclusive length counts both endpoints: Mar 1..Mar 5 is 5 days.
eq(lengthDays(w), 5, "inclusive length counts both endpoints");

const oneDay = { start: "2026-07-04", end: "2026-07-04" };
eq(contains(oneDay, "2026-07-04"), true, "one-day window contains its day");
eq(lengthDays(oneDay), 1, "one-day window has length 1");

// Windows that touch at a single day DO overlap.
eq(
  overlaps({ start: "2026-01-01", end: "2026-01-10" }, { start: "2026-01-10", end: "2026-01-20" }),
  true,
  "windows touching on one day overlap",
);
eq(
  overlaps({ start: "2026-01-01", end: "2026-01-09" }, { start: "2026-01-10", end: "2026-01-20" }),
  false,
  "adjacent but disjoint windows do not overlap",
);

done();
