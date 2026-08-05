const { eq, done } = require("../../../test/helper");
const { round, sum, format } = require("../src/money");

console.log("money");

// Ordinary rounding.
eq(round(2.004, "USD"), 2.0, "2.004 -> 2.00");
eq(round(2.006, "USD"), 2.01, "2.006 -> 2.01");

// Ties round AWAY FROM ZERO, both directions. This is the whole point:
// Math.round sends -2.005 to -2.00 because it breaks ties toward
// +Infinity, and the invoice reconciliation does not accept that.
eq(round(2.005, "USD"), 2.01, "positive tie rounds away from zero");
eq(round(-2.005, "USD"), -2.01, "negative tie rounds away from zero");
eq(round(-0.005, "USD"), -0.01, "negative tie near zero");

// Symmetry: rounding a negative is the negation of rounding its absolute.
eq(round(-1.115, "USD"), -round(1.115, "USD"), "rounding is symmetric about zero");

// Zero-decimal currencies.
eq(round(1234.5, "JPY"), 1235, "JPY tie rounds away from zero");
eq(round(-1234.5, "JPY"), -1235, "negative JPY tie rounds away from zero");

// Sums round once, at the end.
eq(sum([0.1, 0.2], "USD"), 0.3, "0.1 + 0.2 -> 0.30");
eq(sum([-2.005, -2.005], "USD"), -4.01, "negative sum rounds away from zero");

eq(format(-2.005, "USD"), "-2.01 USD", "format uses the same rounding");

done();
