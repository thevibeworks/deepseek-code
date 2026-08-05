const { eq, done } = require("../../../test/helper");
const { runningBalance, closingBalance } = require("../src/balance");

console.log("balance");

const entries = [
  { id: "e1", amount: 100 },
  { id: "e2", amount: -30 },
  { id: "e3", amount: 5 },
];

const rows = runningBalance(0, entries);

eq(rows.length, 3, "one row per entry");

// Each row's balance INCLUDES its own entry.
eq(rows[0].balance, 100, "first row includes its own entry");
eq(rows[1].balance, 70, "second row includes entries 1..2");
eq(rows[2].balance, 75, "third row includes entries 1..3");

// The last row must agree with the closing balance.
eq(rows[rows.length - 1].balance, closingBalance(0, entries), "last row equals closing balance");

// Non-zero opening balance.
const opened = runningBalance(50, entries);
eq(opened[0].balance, 150, "opening balance is included in the first row");
eq(opened[2].balance, 125, "opening balance carries through");

// Empty ledger.
eq(runningBalance(10, []), [], "no entries means no rows");

// Ids and amounts are preserved alongside the balance.
eq(rows[1].id, "e2", "row keeps its entry id");
eq(rows[1].amount, -30, "row keeps its entry amount");

done();
