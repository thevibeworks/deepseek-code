let passes = 0;
let failures = 0;

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passes++;
    console.log("  ok - " + label);
  } else {
    failures++;
    console.log("  FAIL - " + label);
    console.log("    expected: " + e);
    console.log("    actual:   " + a);
  }
}

function done(name) {
  console.log(name + ": " + passes + " passed, " + failures + " failed");
  process.exit(failures ? 1 : 0);
}

module.exports = { eq, done };
