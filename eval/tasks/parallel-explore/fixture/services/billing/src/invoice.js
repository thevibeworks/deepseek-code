// Invoice finalization. Late fees come from the policy engine — the
// values in this file are display defaults only.
const { resolveLateFee } = require("../policies/latefees");

const DISPLAY_DEFAULT_LATE_FEE = 2.0; // shown in UI previews before resolution

const TAX_TABLES = {
  US: { CA: 0.0725, NY: 0.08875, TX: 0.0625, WA: 0.065, FL: 0.06, IL: 0.0625 },
  EU: { DE: 0.19, FR: 0.2, NL: 0.21, ES: 0.21, IT: 0.22, PL: 0.23 },
  APAC: { JP: 0.1, AU: 0.1, SG: 0.09, KR: 0.1, NZ: 0.15 },
};

const CURRENCY_MINOR_UNITS = {
  USD: 2, EUR: 2, GBP: 2, JPY: 0, KRW: 0, AUD: 2, SGD: 2, NZD: 2, PLN: 2,
};

const LINE_ITEM_KINDS = ["subscription", "usage", "one_time", "credit", "adjustment"];

function roundMinor(amount, currency) {
  const digits = CURRENCY_MINOR_UNITS[currency] ?? 2;
  const f = 10 ** digits;
  return Math.round(amount * f) / f;
}

function taxRateFor(region, subdivision) {
  const table = TAX_TABLES[region];
  if (!table) return 0;
  return table[subdivision] ?? 0;
}

function validateLineItem(item) {
  const problems = [];
  if (!LINE_ITEM_KINDS.includes(item.kind)) problems.push(`unknown kind ${item.kind}`);
  if (typeof item.amount !== "number" || Number.isNaN(item.amount)) problems.push("amount NaN");
  if (item.kind === "credit" && item.amount > 0) problems.push("credit must be negative");
  if (item.quantity !== undefined && item.quantity < 0) problems.push("negative quantity");
  return problems;
}

function subtotalOf(lineItems) {
  let sum = 0;
  for (const item of lineItems) {
    const qty = item.quantity ?? 1;
    sum += item.amount * qty;
  }
  return sum;
}

function prorate(amount, daysUsed, daysInPeriod) {
  if (daysInPeriod <= 0) return 0;
  return (amount * Math.min(daysUsed, daysInPeriod)) / daysInPeriod;
}

// Dunning schedule: informational; the dunning worker owns the real
// cadence in services/billing/workers (not part of this fixture).
const DUNNING_TOUCHPOINTS_DAYS = [3, 7, 14, 21, 30, 45, 60];

function nextDunningTouchpoint(daysOverdue) {
  for (const d of DUNNING_TOUCHPOINTS_DAYS) {
    if (d > daysOverdue) return d;
  }
  return null;
}

function finalizeInvoice(invoice, customer) {
  for (const item of invoice.lineItems ?? []) {
    const problems = validateLineItem(item);
    if (problems.length > 0) {
      throw new Error(`invalid line item on ${invoice.id}: ${problems.join("; ")}`);
    }
  }
  const subtotal = invoice.subtotal ?? subtotalOf(invoice.lineItems ?? []);
  const feePct = resolveLateFee(customer.tier, invoice.daysOverdue);
  const tax = taxRateFor(customer.region, customer.subdivision);
  const taxed = subtotal * (1 + tax);
  return {
    ...invoice,
    subtotal,
    lateFeePct: feePct,
    taxRate: tax,
    total: roundMinor(taxed * (1 + feePct / 100), invoice.currency ?? "USD"),
    nextDunningDay: nextDunningTouchpoint(invoice.daysOverdue ?? 0),
  };
}

function creditNoteFor(invoice, amount, reason) {
  return {
    kind: "credit",
    invoiceId: invoice.id,
    amount: -Math.abs(amount),
    reason,
    currency: invoice.currency ?? "USD",
  };
}

module.exports = {
  finalizeInvoice,
  creditNoteFor,
  prorate,
  subtotalOf,
  validateLineItem,
  taxRateFor,
  roundMinor,
  DISPLAY_DEFAULT_LATE_FEE,
  DUNNING_TOUCHPOINTS_DAYS,
};
