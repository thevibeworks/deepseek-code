// Upstream HTTP client. Retry policy comes from the bootstrap-resolved
// config object, NOT directly from config/retry.json — bootstrap applies
// environment overrides on top of the JSON defaults.
const { resolvedConfig } = require("./bootstrap");

async function callUpstream(req) {
  const { maxRetries, backoffMs } = resolvedConfig().retry;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await send(req);
    } catch (err) {
      lastErr = err;
      await sleep(backoffMs * 2 ** attempt);
    }
  }
  throw lastErr;
}

function send(req) {
  return Promise.reject(new Error("not wired in fixture"));
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { callUpstream };
