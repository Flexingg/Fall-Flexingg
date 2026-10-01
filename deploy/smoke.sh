#!/usr/bin/env bash
# End-to-end check of a running Gauntlet + SparkyFitness: sign up through Gauntlet, push a
# Health Connect-style record, sync, and read it back on Today. Creates a throwaway account.
#
#   deploy/smoke.sh https://gauntlet.example.com https://sparky.example.com
set -euo pipefail
G="${1:?Gauntlet URL}"; S="${2:?SparkyFitness URL}"
G="${G%/}"; S="${S%/}"
need() { command -v "$1" >/dev/null || { echo "smoke: needs $1" >&2; exit 2; }; }
need curl; need jq
fail() { echo "smoke: FAIL: $*" >&2; exit 1; }
h=(-H 'content-type: application/json' -H 'x-gauntlet-client: native' -H 'x-timezone: UTC')

curl -fsS "$G/api/health" >/dev/null || fail "Gauntlet $G/api/health"
curl -fsS "$S/api/health" >/dev/null || fail "SparkyFitness $S/api/health"
echo "smoke: both services healthy"

email="smoke-$(date +%s)-$RANDOM@example.com"
res=$(curl -sS "${h[@]}" -X POST "$G/api/auth/signup" \
  -d "{\"name\":\"Smoke Test\",\"email\":\"$email\",\"password\":\"smoke-$(openssl rand -hex 8)\"}")
token=$(jq -r '.accessToken // empty' <<<"$res")
[ -n "$token" ] || fail "sign-up: $res"
echo "smoke: signed up $email"
auth=(-H "authorization: Bearer $token")

today=$(date -u +%F)
res=$(curl -sS "${h[@]}" "${auth[@]}" -X POST "$G/api/ingest/health-connect" \
  -d "{\"records\":[{\"type\":\"step\",\"value\":12345,\"date\":\"$today\",\"unit\":\"count\"}]}")
[ "$(jq -r '.errors // 1' <<<"$res")" = 0 ] || fail "ingest: $res"
echo "smoke: pushed 12,345 steps for $today"

for _ in $(seq 1 20); do
  curl -sS "${h[@]}" "${auth[@]}" -X POST "$G/api/me/sync" -d '{}' >/dev/null || true
  steps=$(curl -sS "${h[@]}" "${auth[@]}" "$G/api/me/today" | jq -r '.metrics[] | select(.key=="steps") | .value')
  [ "$steps" = 12345 ] && { echo "smoke: Today shows 12345 steps. OK"; exit 0; }
  sleep 3
done
fail "Today shows steps=$steps, expected 12345"
