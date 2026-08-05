const { eq, done } = require("./helper.js");
const { formatCents } = require("../src/currency.js");

eq(formatCents(4509), "$45.09", "sub-ten cents zero-padded");
eq(formatCents(100), "$1.00", "whole dollars");
eq(formatCents(7), "$0.07", "cents only");
eq(formatCents(99), "$0.99", "just under a dollar");
eq(formatCents(123456), "$1234.56", "large amounts");
eq(formatCents(0), "$0.00", "zero");

done("05-currency");
