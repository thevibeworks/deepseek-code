#!/usr/bin/env bash
# Pass iff: tests pass, test.js untouched, and the buggy non-collapsing
# regex is actually gone (not worked around elsewhere).
set -u
node test.js >/dev/null 2>&1 || exit 1
[ "$(sha256sum test.js | cut -d' ' -f1)" = "7b14c86d9c385836b39113a1ba49caf8b615382f73e7459810b802f05ee34bdb" ] || exit 1
if grep -qF '[^a-z0-9]/g' slugify.js; then exit 1; fi
exit 0
