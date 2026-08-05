// Search-query tokenizer.
//
// Contract: bare words split on whitespace. A double-quoted run is ONE
// token with the quotes stripped, and a backslash inside quotes escapes
// the next character, so \" is a literal quote that does NOT close the
// string and \\ is a literal backslash. An unterminated quote consumes
// the rest of the input.

function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === " " || ch === "\t" || ch === "\n") {
      i++;
      continue;
    }
    if (ch === '"') {
      i++;
      let value = "";
      while (i < input.length && input[i] !== '"') {
        value += input[i];
        i++;
      }
      i++; // closing quote
      tokens.push({ type: "phrase", value });
      continue;
    }
    let value = "";
    while (i < input.length && !" \t\n".includes(input[i])) {
      value += input[i];
      i++;
    }
    tokens.push({ type: "word", value });
  }
  return tokens;
}

module.exports = { tokenize };
