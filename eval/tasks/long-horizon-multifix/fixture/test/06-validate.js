const { eq, done } = require("./helper.js");
const { isEmail } = require("../src/validate.js");

eq(isEmail("a@b.co"), true, "plain address");
eq(isEmail("first.last@example.com"), true, "dots in local part");
eq(isEmail("a+tag@example.io"), true, "plus addressing accepted");
eq(isEmail("UPPER@EXAMPLE.COM"), true, "case insensitive");
eq(isEmail("no-at-sign"), false, "missing @");
eq(isEmail("a@b"), false, "missing TLD");
eq(isEmail("a b@example.com"), false, "spaces rejected");

done("06-validate");
