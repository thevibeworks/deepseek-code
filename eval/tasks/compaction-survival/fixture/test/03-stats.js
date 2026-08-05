const { eq, done } = require("./helper.js");
const { sum, median } = require("../src/stats.js");

eq(sum([]), 0, "sum of empty is 0");
eq(sum([1, 2, 3]), 6, "sum basic");
eq(median([5]), 5, "median of one");
eq(median([3, 1, 2]), 2, "median odd, unsorted input");
eq(median([1, 2, 3, 4]), 2.5, "median even is average of middle two");
eq(median([10, 2]), 6, "median of two");
eq(median([7, 7, 7, 7]), 7, "median even, all equal");

done("03-stats");
