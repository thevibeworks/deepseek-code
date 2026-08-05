// Fail-fast runner for this service: stops at the first failing file.
const { readdirSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

const files = readdirSync(__dirname)
  .filter((f) => /^\d\d-.*\.js$/.test(f))
  .sort();

for (const f of files) {
  const r = spawnSync(process.execPath, [join(__dirname, f)], { stdio: "inherit" });
  if (r.status !== 0) {
    console.log(`FAILED at ${f} — fix the module it tests, then re-run.`);
    process.exit(1);
  }
}
console.log(`All ${files.length} test files passed.`);
