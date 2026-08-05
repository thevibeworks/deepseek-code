const { eq, done } = require("../../../test/helper");
const { tokenize } = require("../src/tokenize");

console.log("tokenize");

const values = (s) => tokenize(s).map((t) => t.value);
const types = (s) => tokenize(s).map((t) => t.type);

eq(values("red green"), ["red", "green"], "bare words split on whitespace");
eq(values('"red green"'), ["red green"], "quoted run is one token, quotes stripped");
eq(types('"red green"'), ["phrase"], "quoted run is a phrase token");
eq(values('a  "b c"   d'), ["a", "b c", "d"], "mixed words and phrases");

// A backslash inside quotes escapes the next character. \" is a literal
// quote and must NOT terminate the phrase.
eq(values('"say \\"hi\\" now"'), ['say "hi" now'], "escaped quotes stay inside the phrase");
eq(types('"say \\"hi\\" now"'), ["phrase"], "escaped quotes do not split the phrase");

// A literal backslash is written \\ and survives as one backslash.
eq(values('"back\\\\slash"'), ["back\\slash"], "escaped backslash becomes one backslash");

// Escape immediately before the closing quote.
eq(values('"trailing\\\\"'), ["trailing\\"], "phrase ending in an escaped backslash");

// Unterminated quotes consume the rest of the input.
eq(values('"open ended'), ["open ended"], "unterminated quote takes the rest");

done();
