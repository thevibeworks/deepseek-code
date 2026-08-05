#!/usr/bin/env bash
# Pass iff all six answer lines carry the layered runtime values:
#   billing: 4.5   (enterprise penalty; not base 3.5 / smb 3.0 / display 2.0)
#   gateway: 7     (production env override; not JSON default 3 / historical 5)
#   indexer: 256   (hard cap; not configured 500 / incremental 64)
#   notifier: 25   (ops override for production; not default 15 / dev 5 / staging 10)
#   auth: 21       (mobile cap; not base 30 / web-extended 90)
#   metrics: 12.5  (checkout rule; not global 1 / search 2 / health 0)
set -u
RESULT_FILE="${1:?usage: verify.sh <result-file>}"

check() { # check <key> <good-regex> <bad-regex>
  local line
  line=$(grep -Ei "^[[:space:]]*$1[[:space:]]*:" "$RESULT_FILE" | tail -n 1)
  [ -n "$line" ] || return 1
  echo "$line" | grep -Eq "$2" || return 1
  echo "$line" | grep -Eq "$3" && return 1
  return 0
}

check "billing" '(^|[^0-9.])4\.5([^0-9]|$)' '3\.5|3\.0|2\.0' || exit 1
check "gateway" '(^|[^0-9])7([^0-9]|$)' '(^|[^0-9])(3|5)([^0-9]|$)' || exit 1
check "indexer" '(^|[^0-9])256([^0-9]|$)' '500|64' || exit 1
check "notifier" '(^|[^0-9])25([^0-9]|$)' '(^|[^0-9])(15|10|5)([^0-9]|$)' || exit 1
check "auth" '(^|[^0-9])21([^0-9]|$)' '(^|[^0-9])(30|90)([^0-9]|$)' || exit 1
check "metrics" '(^|[^0-9.])12\.5([^0-9]|$)' '(^|[^0-9])(1|2|0)([^0-9.]|$)' || exit 1
exit 0
