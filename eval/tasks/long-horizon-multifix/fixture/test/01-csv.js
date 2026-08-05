const { eq, done } = require("./helper.js");
const { parseCSV } = require("../src/csv.js");

eq(parseCSV("a,b\nc,d\n"), [["a", "b"], ["c", "d"]], "two rows, trailing newline");
eq(parseCSV("a,b\nc,d"), [["a", "b"], ["c", "d"]], "two rows, no trailing newline");
eq(parseCSV("x,y,z"), [["x", "y", "z"]], "single row, no trailing newline");
eq(parseCSV(""), [], "empty input");
eq(parseCSV("a\n\nb\n"), [["a"], ["b"]], "blank lines skipped");

done("01-csv");
