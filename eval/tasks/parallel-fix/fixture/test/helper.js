// Minimal assertion helper shared by every service suite.
let failures = 0;

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.log(`  FAIL ${label}\n    expected ${e}\n    actual   ${a}`);
  } else {
    console.log(`  ok   ${label}`);
  }
}

function near(actual, expected, epsilon, label) {
  if (typeof actual !== "number" || Math.abs(actual - expected) > epsilon) {
    failures++;
    console.log(`  FAIL ${label}\n    expected ~${expected} (+-${epsilon})\n    actual   ${actual}`);
  } else {
    console.log(`  ok   ${label}`);
  }
}

function done() {
  if (failures > 0) {
    console.log(`\n${failures} assertion(s) failed.`);
    process.exit(1);
  }
}

module.exports = { eq, near, done };
