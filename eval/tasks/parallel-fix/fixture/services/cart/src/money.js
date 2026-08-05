// Money rounding to a currency's minor units.
//
// Contract: round HALF AWAY FROM ZERO, which is what finance expects and
// what the invoice totals are reconciled against. 2.005 -> 2.01 and
// -2.005 -> -2.01 (NOT -2.00). JavaScript's Math.round breaks ties
// toward +Infinity, so it cannot be used directly on negative amounts.

const MINOR_UNITS = { USD: 2, EUR: 2, GBP: 2, JPY: 0, KRW: 0 };

function minorUnits(currency) {
  return MINOR_UNITS[currency] ?? 2;
}

function round(amount, currency) {
  const factor = 10 ** minorUnits(currency);
  return Math.round(amount * factor) / factor;
}

function sum(amounts, currency) {
  let total = 0;
  for (const a of amounts) total += a;
  return round(total, currency);
}

function format(amount, currency) {
  return `${round(amount, currency).toFixed(minorUnits(currency))} ${currency}`;
}

module.exports = { round, sum, format, minorUnits, MINOR_UNITS };
