# logmetrics

Small utility library for processing transaction event logs
(`data/events.csv`): CSV parsing, date helpers, stats, text and
currency formatting, validation, and a summary pipeline in
`src/index.js`.

## Tests

```
node test/run.js
```

The runner is fail-fast: it executes the files in `test/` in order and
stops at the first file with failures. Fix the module it points at,
re-run, and continue until the whole suite passes.

Do not modify anything in `test/` or `data/` — they are the spec.
