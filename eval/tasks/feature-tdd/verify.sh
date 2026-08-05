#!/usr/bin/env bash
# Pass iff: duration.js exists, tests pass, test file untouched.
set -u
[ -f duration.js ] || exit 1
node duration.test.js >/dev/null 2>&1 || exit 1
[ "$(sha256sum duration.test.js | cut -d' ' -f1)" = "4c2b80656718becc1a3e3600ddf25cdce79a53e3d7939c8c54cb83fe24e18bfa" ] || exit 1
exit 0
