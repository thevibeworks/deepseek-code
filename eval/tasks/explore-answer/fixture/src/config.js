const fs = require('node:fs');
const path = require('node:path');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const DEPLOY_DIR = path.join(__dirname, '..', 'deploy');

// Env-file variables that map onto config keys. Deployment env files are
// the last word: they override every overlay and default.
const ENV_KEY_MAP = {
  GATEWAY_PORT: 'port',
  GATEWAY_HOST: 'host',
  LOG_LEVEL: 'logLevel',
};

function loadOverlay(name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`overlay cycle at ${name}`);
  seen.add(name);
  const file = path.join(CONFIG_DIR, 'overlays', `${name}.json`);
  const overlay = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = overlay.extends ? loadOverlay(overlay.extends, seen) : {};
  const { extends: _ignored, ...rest } = overlay;
  return { ...base, ...rest };
}

function loadEnvFile(name) {
  const file = path.join(DEPLOY_DIR, `${name}.env`);
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (!m || !(m[1] in ENV_KEY_MAP)) continue;
    const key = ENV_KEY_MAP[m[1]];
    out[key] = /^\d+$/.test(m[2]) ? Number(m[2]) : m[2];
  }
  return out;
}

// Precedence, lowest to highest: defaults < overlay chain < deploy env file.
function loadConfig(envName) {
  const defaults = JSON.parse(
    fs.readFileSync(path.join(CONFIG_DIR, 'defaults.json'), 'utf8'),
  );
  return { ...defaults, ...loadOverlay(envName), ...loadEnvFile(envName) };
}

module.exports = { loadConfig };
