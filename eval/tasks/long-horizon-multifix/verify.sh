#!/usr/bin/env bash
# Pass iff: full fail-fast suite passes and test/ + data/ are untouched
# (single hash over all test files and the dataset, deleted/added test
# files change the hash too).
set -u
node test/run.js >/dev/null 2>&1 || exit 1
HASH=$(LC_ALL=C cat test/*.js data/events.csv | sha256sum | cut -d' ' -f1)
[ "$HASH" = "cddcfe8eb354ff203754934a2c145b68fb88a50aaaeb5bc109d622fa760e9404" ] || exit 1
exit 0
