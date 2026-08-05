// Regenerates fixture/data/events.csv and prints the expected
// integration summary computed with the reference implementation in
// solution/src. Deterministic (LCG, seed 42) — run only when the task
// is being redesigned; the pinned hash in verify.sh and the expected
// values in test/07-integration.js must be updated together.
const { writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

let seed = 42 >>> 0;
function rand(n) {
  seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
  return seed % n;
}

const COUNTRIES = ["US", "DE", "JP", "BR", "IN"];
const pad = (x) => String(x).padStart(2, "0");
const base = Date.UTC(2026, 0, 1); // rows spread over Q1 2026

const lines = ["timestamp,user,amount_cents,country,status"];
for (let i = 0; i < 5000; i++) {
  const d = new Date(base + rand(90) * 86400000);
  const ts = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(rand(24))}:${pad(rand(60))}:00Z`;
  const user = "u" + (1000 + rand(9000));
  const amount = 100 + rand(99900);
  const country = COUNTRIES[rand(5)];
  const r = rand(10);
  const status = r < 7 ? "ok" : r < 9 ? "pending" : "error";
  lines.push([ts, user, amount, country, status].join(","));
}

const csv = lines.join("\n") + "\n";
mkdirSync(join(__dirname, "fixture", "data"), { recursive: true });
writeFileSync(join(__dirname, "fixture", "data", "events.csv"), csv);

const { summarize } = require(join(__dirname, "solution", "src", "index.js"));
console.log("bytes:", csv.length);
console.log("expected:", JSON.stringify(summarize(csv)));
