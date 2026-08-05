// Config bootstrap: JSON defaults, then production env-file overrides.
// Production deploys always source env/production.env (see deploy notes
// in that file); staging has no env file and keeps the JSON defaults.
const fs = require("fs");
const path = require("path");

function resolvedConfig() {
  const defaults = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../config/retry.json"), "utf8"),
  );
  const envFile = path.join(__dirname, "../env/production.env");
  const overrides = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, "utf8")) : {};
  return {
    retry: {
      maxRetries: overrides.GW_RETRY_MAX !== undefined
        ? Number(overrides.GW_RETRY_MAX)
        : defaults.maxRetries,
      backoffMs: defaults.backoffMs,
    },
  };
}

function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

module.exports = { resolvedConfig };
