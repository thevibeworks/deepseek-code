// Enterprise tier late-fee schedule (contract addendum 2025-11).
// Overdue > 30 days: contractual penalty rate applies, replacing the
// base rate entirely.
const ENTERPRISE_PENALTY_PCT = 4.5;

function lateFee(daysOverdue, baseRate) {
  if (daysOverdue > 30) return ENTERPRISE_PENALTY_PCT;
  return baseRate;
}

module.exports = { lateFee, ENTERPRISE_PENALTY_PCT };
