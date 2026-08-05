const { eq, near, done } = require("../../../test/helper");
const { applyDiscounts } = require("../src/discount");

console.log("discount");

// Single discounts are unambiguous.
near(applyDiscounts(100, ["WELCOME10"]), 90, 1e-9, "single 10% off 100 -> 90");
near(applyDiscounts(100, ["FIVEOFF"]), 95, 1e-9, "single flat 5 off 100 -> 95");

// Stacking is SEQUENTIAL: each discount applies to what remains.
// 10% then 20% => 100 * 0.9 * 0.8 = 72 (NOT 100 - 30 = 70).
near(applyDiscounts(100, ["WELCOME10", "LOYAL20"]), 72, 1e-9, "10% then 20% -> 72");

// Two 50% discounts leave a quarter, they do not zero the price.
near(applyDiscounts(80, ["HALFOFF", "HALFOFF"]), 20, 1e-9, "50% twice on 80 -> 20");

// Order must not matter for percent-only stacks.
near(
  applyDiscounts(250, ["LOYAL20", "WELCOME10"]),
  applyDiscounts(250, ["WELCOME10", "LOYAL20"]),
  1e-9,
  "percent stack is order-independent",
);

// Mixed flat + percent: flat applies to the running price too.
// 100 -> FIVEOFF -> 95 -> 20% -> 76
near(applyDiscounts(100, ["FIVEOFF", "LOYAL20"]), 76, 1e-9, "flat then percent -> 76");

// Unknown codes are ignored, not errors.
near(applyDiscounts(100, ["NOPE", "WELCOME10"]), 90, 1e-9, "unknown code ignored");

// Never negative.
eq(applyDiscounts(8, ["TENOFF"]) === 0, true, "flat larger than price clamps to 0");

done();
