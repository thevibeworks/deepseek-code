// Minimal config loader for config.yml (flat two-level YAML subset).
const fs = require("fs");
const path = require("path");

function load() {
  const text = fs.readFileSync(path.join(__dirname, "../config.yml"), "utf8");
  const out = {};
  let section = null;
  for (const line of text.split("\n")) {
    const sec = line.match(/^(\w+):\s*$/);
    const kv = line.match(/^\s+(\w+):\s*(\S+)/);
    if (sec) {
      section = sec[1];
      out[section] = {};
    } else if (kv && section) {
      out[section][kv[1]] = Number.isNaN(Number(kv[2])) ? kv[2] : Number(kv[2]);
    }
  }
  return out;
}

module.exports = { load };
