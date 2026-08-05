const assert = require('node:assert');
const parseDuration = require('./duration');

// happy path
assert.strictEqual(parseDuration('90s'), 90000);
assert.strictEqual(parseDuration('150ms'), 150);
assert.strictEqual(parseDuration('2d'), 172800000);
assert.strictEqual(parseDuration('1h30m'), 5400000);
assert.strictEqual(parseDuration('1h1m1s'), 3661000);
assert.strictEqual(parseDuration('1s500ms'), 1500);
assert.strictEqual(parseDuration('0s'), 0);

// errors
assert.throws(() => parseDuration(''));
assert.throws(() => parseDuration('abc'));
assert.throws(() => parseDuration('1x'));
assert.throws(() => parseDuration('h'));
assert.throws(() => parseDuration('1m1h'), /order/i); // units must be largest-first
assert.throws(() => parseDuration(42));

console.log('ok');
