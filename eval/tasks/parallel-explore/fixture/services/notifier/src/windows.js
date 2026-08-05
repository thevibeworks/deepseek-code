// Coalescing window resolution: code default, then ops override file
// (ops/overrides.json) wins if it names the environment. The ops file is
// the source of truth in production — it is what the on-call rota edits.
const fs = require("fs");
const path = require("path");

const DEFAULT_WINDOW_MIN = 15;
const DEBUG_WINDOW_MIN = 5; // local/dev only, never shipped

function coalescingWindowMinutes(envName) {
  if (envName === "dev") return DEBUG_WINDOW_MIN;
  const opsFile = path.join(__dirname, "../ops/overrides.json");
  if (fs.existsSync(opsFile)) {
    const ops = JSON.parse(fs.readFileSync(opsFile, "utf8"));
    if (ops.coalescing && ops.coalescing[envName] !== undefined) {
      return ops.coalescing[envName];
    }
  }
  return DEFAULT_WINDOW_MIN;
}

module.exports = { coalescingWindowMinutes, DEFAULT_WINDOW_MIN };
