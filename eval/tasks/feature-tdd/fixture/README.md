# duration

Tiny duration-string parser.

`parseDuration(str)` takes strings like `"1h30m"`, `"90s"`, `"150ms"` and
returns total milliseconds. Units: `d`, `h`, `m`, `s`, `ms`. Units must
appear in largest-to-smallest order, each at most once. Invalid input
throws an Error.

Run tests: `node duration.test.js`
