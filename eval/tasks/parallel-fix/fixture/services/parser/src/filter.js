// Boolean filter expressions over tokens.
//
// Contract: AND binds TIGHTER than OR, exactly as in every other query
// language. "a OR b AND c" means "a OR (b AND c)", never "(a OR b) AND c".
// Bare adjacency is an implicit AND. Parsing is a two-level descent:
// an expression is OR-separated terms, a term is AND-separated factors.

const { tokenize } = require("./tokenize");

function parse(input) {
  const tokens = tokenize(input).map((t) => t.value);
  let pos = 0;

  function peek() {
    return pos < tokens.length ? tokens[pos] : null;
  }

  function parseFactor() {
    const tok = tokens[pos++];
    return { type: "match", value: tok };
  }

  function parseExpression() {
    let left = parseFactor();
    while (peek() !== null) {
      const tok = peek();
      if (tok === "OR") {
        pos++;
        const right = parseFactor();
        left = { type: "or", left, right };
      } else {
        if (tok === "AND") pos++;
        const right = parseFactor();
        left = { type: "and", left, right };
      }
    }
    return left;
  }

  return parseExpression();
}

function evaluate(node, haystack) {
  if (node.type === "match") return haystack.includes(node.value);
  if (node.type === "and") return evaluate(node.left, haystack) && evaluate(node.right, haystack);
  return evaluate(node.left, haystack) || evaluate(node.right, haystack);
}

module.exports = { parse, evaluate };
