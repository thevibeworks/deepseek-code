#!/usr/bin/env bash
# Pass iff the final non-empty line of the result is exactly the staging
# port (7443) — not the defaults (8080), production overlay (9443), or
# legacy decoy (8443).
set -u
RESULT_FILE="${1:?usage: verify.sh <result-file>}"
LAST=$(grep -v '^[[:space:]]*$' "$RESULT_FILE" | tail -n 1)
echo "$LAST" | grep -Eq '(^|[^0-9])7443([^0-9]|$)' || exit 1
echo "$LAST" | grep -Eq '8080|9443|8443' && exit 1
exit 0
