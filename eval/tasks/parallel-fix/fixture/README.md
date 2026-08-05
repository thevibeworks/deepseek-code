# meridian-services

Four independent services. They share no code and no data — each owns its
own `src/` and its own test suite.

- `services/cart` — pricing, discounts, money rounding
- `services/schedule` — recurrence and booking windows
- `services/parser` — query tokenizer and boolean filters
- `services/ledger` — running balances and reconciliation

Run everything: `node test/run-all.js` (reports every service).
Run one service: `node services/<name>/test/run.js` (fail-fast).

Each module's contract is documented in a comment at the top of the file.
The tests encode those contracts.
