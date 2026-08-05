// Span sampling rules, in percent. First match wins; prefix match.
// checkout.* spans are business-critical and sampled far above default;
// health checks are dropped entirely.
const RULES = [
  { prefix: "health.", pct: 0 },
  { prefix: "checkout.", pct: 12.5 },
  { prefix: "search.suggest", pct: 2 },
];

function rateForSpan(spanName) {
  for (const r of RULES) {
    if (spanName.startsWith(r.prefix)) return r.pct;
  }
  return null;
}

module.exports = { rateForSpan };
