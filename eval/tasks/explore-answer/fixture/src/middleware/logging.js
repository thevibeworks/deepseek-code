const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function logRequest(config, req) {
  if (LEVELS[config.logLevel] > LEVELS.info) return;
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
}

module.exports = { logRequest };
