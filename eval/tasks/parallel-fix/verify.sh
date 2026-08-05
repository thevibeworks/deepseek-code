#!/usr/bin/env bash
# Pass iff all four service suites pass AND no test file was touched.
# The hash covers the shared helper, the cross-service runner, and every
# per-service test file (added/deleted test files change it too).
set -u
node test/run-all.js >/dev/null 2>&1 || exit 1
HASH=$(LC_ALL=C cat test/helper.js test/run-all.js services/*/test/*.js | sha256sum | cut -d' ' -f1)
[ "$HASH" = "da159677bfa27ea07807d8d4fec6be7ac2cb327aa7489f63d9ddd7f210ec530a" ] || exit 1
exit 0
