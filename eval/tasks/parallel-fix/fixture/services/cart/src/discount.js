// Discount stacking.
//
// Contract: multiple discounts apply SEQUENTIALLY, each to the price that
// remains after the previous one. Two 50% discounts leave 25% of the
// original price, not 0. Order does not affect the result.
//
// Codes are applied in the order given; unknown codes are ignored.

const CODES = {
  WELCOME10: { kind: "percent", value: 10 },
  LOYAL20: { kind: "percent", value: 20 },
  HALFOFF: { kind: "percent", value: 50 },
  FIVEOFF: { kind: "flat", value: 5 },
  TENOFF: { kind: "flat", value: 10 },
};

function lookup(code) {
  return CODES[code] ?? null;
}

function applyOne(price, discount) {
  if (discount.kind === "percent") return price * (1 - discount.value / 100);
  return price - discount.value;
}

function applyDiscounts(price, codes) {
  let total = 0;
  for (const code of codes) {
    const d = lookup(code);
    if (d === null) continue;
    total += d.kind === "percent" ? price * (d.value / 100) : d.value;
  }
  const result = price - total;
  return result < 0 ? 0 : result;
}

module.exports = { applyDiscounts, applyOne, lookup, CODES };
