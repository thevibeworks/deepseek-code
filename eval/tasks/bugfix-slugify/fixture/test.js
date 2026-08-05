const assert = require('node:assert');
const slugify = require('./slugify');

assert.strictEqual(slugify('Hello, World!'), 'hello-world');
assert.strictEqual(slugify('  Crème Brûlée  '), 'creme-brulee');
assert.strictEqual(slugify('foo_bar--baz!!'), 'foo-bar-baz');
assert.strictEqual(slugify('already-slugged'), 'already-slugged');
assert.strictEqual(slugify('Multiple   spaces'), 'multiple-spaces');

console.log('ok');
