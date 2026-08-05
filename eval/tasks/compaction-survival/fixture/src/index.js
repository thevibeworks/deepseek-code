const { parseCSV } = require("./csv.js");
const { median, sum } = require("./stats.js");
const { formatCents } = require("./currency.js");
const { dayName, DAY_NAMES } = require("./dates.js");

// csvText: header row, then timestamp,user,amount_cents,country,status.
// Only rows with status "ok" count as revenue.
function summarize(csvText) {
  const rows = parseCSV(csvText).slice(1);
  const ok = rows.filter((r) => r[4] !== "error");
  const amounts = ok.map((r) => Number(r[2]));
  const byDay = {};
  for (const r of ok) {
    const day = dayName(r[0]);
    byDay[day] = (byDay[day] || 0) + Number(r[2]);
  }
  let busiestDay = null;
  for (const day of DAY_NAMES) {
    if (busiestDay === null || (byDay[day] || 0) > (byDay[busiestDay] || 0)) busiestDay = day;
  }
  return {
    count: ok.length,
    totalRevenue: formatCents(sum(amounts)),
    medianCents: median(amounts),
    busiestDay,
  };
}

module.exports = { summarize };
