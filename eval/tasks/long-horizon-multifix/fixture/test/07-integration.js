const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { eq, done } = require("./helper.js");
const { summarize } = require("../src/index.js");

const csv = readFileSync(join(__dirname, "..", "data", "events.csv"), "utf8");
const s = summarize(csv);

eq(s.count, 3445, "count of ok transactions");
eq(s.totalRevenue, "$1707084.93", "total revenue over ok transactions");
eq(s.medianCents, 49222, "median transaction amount");
eq(s.busiestDay, "Thursday", "weekday with highest ok revenue");

done("07-integration");
