// Trace sampling. The global default applies unless a span-name rule
// matches; rules are consulted first (rules/spans.js).
const { rateForSpan } = require("../rules/spans");

const GLOBAL_SAMPLE_PCT = 1; // percent of spans kept, fleet-wide default

function samplePct(spanName) {
  const ruled = rateForSpan(spanName);
  return ruled !== null ? ruled : GLOBAL_SAMPLE_PCT;
}

module.exports = { samplePct, GLOBAL_SAMPLE_PCT };
