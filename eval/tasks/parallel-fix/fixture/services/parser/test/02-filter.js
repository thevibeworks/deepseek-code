const { eq, done } = require("../../../test/helper");
const { parse, evaluate } = require("../src/filter");

console.log("filter");

const match = (query, words) => evaluate(parse(query), words);

// Implicit AND.
eq(match("a b", ["a", "b"]), true, "implicit AND, both present");
eq(match("a b", ["a"]), false, "implicit AND, one missing");

// Explicit operators.
eq(match("a AND b", ["a", "b"]), true, "explicit AND");
eq(match("a OR b", ["a"]), true, "OR, left present");
eq(match("a OR b", ["b"]), true, "OR, right present");
eq(match("a OR b", ["c"]), false, "OR, neither present");

// AND binds tighter than OR: "a OR b AND c" is "a OR (b AND c)".
// With only `a` present that is true; the wrong grouping "(a OR b) AND c"
// would be false.
eq(match("a OR b AND c", ["a"]), true, "a OR (b AND c) with only a");
eq(match("a OR b AND c", ["b", "c"]), true, "a OR (b AND c) with b and c");
eq(match("a OR b AND c", ["b"]), false, "b alone does not satisfy b AND c");

// Same shape, other direction.
eq(match("x AND y OR z", ["z"]), true, "(x AND y) OR z with only z");
eq(match("x AND y OR z", ["x"]), false, "x alone does not satisfy x AND y");

// The AST itself must show the grouping.
eq(parse("a OR b AND c").type, "or", "top of 'a OR b AND c' is OR");
eq(parse("a AND b OR c").type, "or", "top of 'a AND b OR c' is OR");
eq(parse("a AND b").type, "and", "top of 'a AND b' is AND");

done();
