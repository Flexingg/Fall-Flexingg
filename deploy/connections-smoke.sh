#!/usr/bin/env bash
# Links and unlinks apps through a running Gauntlet + real SparkyFitness, using a throwaway account.
# Covers what doesn't need the outside world: provider records, API-key apps, the wger switch, the
# OAuth sign-in address (needs OAuth app keys on the server, so it is skipped without them).
#
#   deploy/connections-smoke.sh https://gauntlet.example.com
set -euo pipefail
G="${1:?Gauntlet URL}"; G="${G%/}"
command -v jq >/dev/null || { echo "needs jq" >&2; exit 2; }
fail() { echo "connections-smoke: FAIL: $*" >&2; exit 1; }
h=(-H 'content-type: application/json' -H 'x-gauntlet-client: native' -H 'x-timezone: UTC')

email="conn-$(date +%s)-$RANDOM@example.com"
token=$(curl -sS "${h[@]}" -X POST "$G/api/auth/signup" \
  -d "{\"name\":\"Conn Test\",\"email\":\"$email\",\"password\":\"conn-$(openssl rand -hex 8)\"}" | jq -r '.accessToken // empty')
[ -n "$token" ] || fail "sign-up"
auth=(-H "authorization: Bearer $token")
api() { curl -sS -w '\n%{http_code}' "${h[@]}" "${auth[@]}" "$@"; }
state() { api "$G/api/connections" | head -n1 | jq -r --arg id "$1" '.connections[] | select(.id==$id) | .state'; }

all=$(api "$G/api/connections" | head -n1 | jq -r '[.connections[].id] | join(",")')
[ "$all" = "garmin,strava,fitbit,oura,polar,coros,hevy,liftosaur,wger" ] || fail "list: $all"
echo "connections-smoke: lists all nine"

[ "$(state wger)" = disconnected ] || fail "wger should start disconnected"
api -X POST "$G/api/connections/wger/connect" -d '{}' | tail -n1 | grep -q 200 || fail "wger connect"
[ "$(state wger)" = connected ] || fail "wger should be connected"
api -X POST "$G/api/connections/wger/disconnect" -d '{}' | tail -n1 | grep -q 200 || fail "wger disconnect"
[ "$(state wger)" = disconnected ] || fail "wger should be disconnected again"
echo "connections-smoke: wger switches on and off in SparkyFitness"

# A Hevy key is checked by a short sync; the real Hevy can't be reached from CI, so only the
# record handling is checked: a connect attempt must not leave a half-made record behind.
api -X POST "$G/api/connections/hevy/connect" -d '{"apiKey":"not-a-real-hevy-key"}' >/dev/null || true
case "$(state hevy)" in disconnected|connected) ;; *) fail "hevy state" ;; esac
api -X POST "$G/api/connections/hevy/disconnect" -d '{}' >/dev/null || true
[ "$(state hevy)" = disconnected ] || fail "hevy should end disconnected"
echo "connections-smoke: Hevy connect and disconnect leave nothing behind"

if [ "$(state coros)" != unavailable ]; then
  out=$(api -X POST "$G/api/connections/coros/connect" -d '{}')
  code=$(tail -n1 <<<"$out")
  # COROS registers itself with COROS's server; from CI that may or may not be reachable.
  case "$code" in 200|502) echo "connections-smoke: COROS sign-in start answered $code" ;; *) fail "coros connect: $out" ;; esac
fi
echo "connections-smoke: OK"
