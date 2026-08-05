// Running balances.
//
// Contract: runningBalance returns one row PER ENTRY, where each row's
// balance includes that entry and every entry before it. The opening
// balance is the starting point, not a row of its own — a ledger with
// three entries produces exactly three rows, and the last row's balance
// equals the closing balance.

function runningBalance(openingBalance, entries) {
  const rows = [];
  let balance = openingBalance;
  for (const entry of entries) {
    rows.push({ id: entry.id, amount: entry.amount, balance });
    balance += entry.amount;
  }
  return rows;
}

function closingBalance(openingBalance, entries) {
  let balance = openingBalance;
  for (const entry of entries) balance += entry.amount;
  return balance;
}

function creditsAndDebits(entries) {
  let credits = 0;
  let debits = 0;
  for (const entry of entries) {
    if (entry.amount >= 0) credits += entry.amount;
    else debits += entry.amount;
  }
  return { credits, debits };
}

module.exports = { runningBalance, closingBalance, creditsAndDebits };
