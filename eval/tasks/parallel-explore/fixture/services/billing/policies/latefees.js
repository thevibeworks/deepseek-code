// Late fee policy resolution. Base rates by tier; tier modules may
// override for specific conditions.
const enterprise = require("./tiers/enterprise");

const BASE_RATES = {
  smb: 3.0,
  enterprise: 3.5, // superseded by tiers/enterprise.js when overdue > 30d
};

function resolveLateFee(tier, daysOverdue) {
  if (tier === "enterprise") return enterprise.lateFee(daysOverdue, BASE_RATES.enterprise);
  return BASE_RATES[tier] ?? BASE_RATES.smb;
}

module.exports = { resolveLateFee, BASE_RATES };
