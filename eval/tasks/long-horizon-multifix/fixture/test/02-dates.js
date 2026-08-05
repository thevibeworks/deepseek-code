const { eq, done } = require("./helper.js");
const { dayName, DAY_NAMES } = require("../src/dates.js");

eq(DAY_NAMES.length, 7, "seven day names");
eq(dayName("2026-01-01"), "Thursday", "2026-01-01 is a Thursday");
eq(dayName("2026-01-13"), "Tuesday", "2026-01-13 is a Tuesday");
eq(dayName("2026-03-01"), "Sunday", "2026-03-01 is a Sunday");
eq(dayName("2026-02-14T09:30:00Z"), "Saturday", "full timestamp accepted");
eq(dayName("2026-12-25"), "Friday", "2026-12-25 is a Friday");

done("02-dates");
