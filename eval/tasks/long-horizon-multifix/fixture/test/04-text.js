const { eq, done } = require("./helper.js");
const { truncate } = require("../src/text.js");

eq(truncate("hi", 8), "hi", "short strings unchanged");
eq(truncate("exactly8", 8), "exactly8", "exact length unchanged");
eq(truncate("hello world", 8), "hello...", "truncated with ellipsis");
eq(truncate("hello world", 8).length, 8, "result never exceeds n");
eq(truncate("abcdefghij", 5), "ab...", "tight budget");

done("04-text");
