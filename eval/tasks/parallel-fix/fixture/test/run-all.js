// Cross-service runner. Deliberately NOT fail-fast across services: it
// runs every service suite and reports the full pass/fail picture, so
// all outstanding work is visible at once. Within a service, that
// service's own runner is fail-fast.
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { readdirSync } = require("node:fs");

const servicesDir = join(__dirname, "..", "services");
const services = readdirSync(servicesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const failed = [];
for (const svc of services) {
  console.log(`\n######## ${svc} ########`);
  const r = spawnSync(process.execPath, [join(servicesDir, svc, "test", "run.js")], {
    stdio: "inherit",
  });
  if (r.status !== 0) failed.push(svc);
}

console.log("\n================ summary ================");
for (const svc of services) {
  console.log(`  ${failed.includes(svc) ? "FAIL" : "PASS"}  ${svc}`);
}
if (failed.length > 0) {
  console.log(`\n${failed.length} of ${services.length} services failing: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`\nAll ${services.length} services pass.`);
