// Liveness and readiness for auth. Liveness answers "is the process
// wedged"; readiness answers "should the load balancer send traffic".
// They are different questions and must not share an implementation.
const START_TIME = Date.now();
const DEPENDENCIES = ["postgres", "redis", "object-store"];

function uptimeSeconds() {
  return Math.floor((Date.now() - START_TIME) / 1000);
}

function liveness() {
  return { status: "ok", service: "auth", uptime_seconds: uptimeSeconds() };
}

async function checkDependency(name, probe) {
  const started = Date.now();
  try {
    await probe();
    return { name, healthy: true, latency_ms: Date.now() - started };
  } catch (err) {
    return { name, healthy: false, latency_ms: Date.now() - started, error: String(err) };
  }
}

async function readiness(probes = {}) {
  const results = await Promise.all(
    DEPENDENCIES.map((name) => checkDependency(name, probes[name] ?? (async () => {}))),
  );
  const unhealthy = results.filter((r) => !r.healthy);
  return {
    status: unhealthy.length === 0 ? "ready" : "degraded",
    service: "auth",
    dependencies: results,
  };
}

module.exports = { liveness, readiness, uptimeSeconds, DEPENDENCIES };
