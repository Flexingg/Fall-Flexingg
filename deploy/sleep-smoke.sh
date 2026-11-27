#!/usr/bin/env bash
# Sleep against a real SparkyFitness (0.18). SparkyFitness ignores the totals in a sleep record and
# works a night out from its stored stages: a night first uploaded partway used to stay that short
# forever, because every later upload without stages kept the one made-up stage. The phone now sends
# the real stages every time (apps/web/src/lib/sleepSessions.ts); this checks, on a throwaway
# account, that a night sent partial and then whole ends up whole, that its totals are the stage
# totals, and that sending it again changes nothing.
#
#   SPARKY_PSQL='docker compose -f deploy/docker-compose.yml --env-file .env exec -T db psql -U postgres -d sparkyfitness_db -At -c' \
#     deploy/sleep-smoke.sh http://localhost:8080
#
# SPARKY_PSQL is a command that runs one SQL statement against SparkyFitness' database (needed to
# look at the stored stages; without it only the totals Gauntlet shows are checked).
set -euo pipefail
G="${1:?Gauntlet URL}"; G="${G%/}"
command -v curl >/dev/null && command -v jq >/dev/null || { echo "sleep-smoke: needs curl and jq" >&2; exit 2; }
fail() { echo "sleep-smoke: FAIL: $*" >&2; exit 1; }
h=(-H 'content-type: application/json' -H 'x-gauntlet-client: native' -H 'x-timezone: UTC')

email="sleep-$(date +%s)-$RANDOM@example.com"
token=$(curl -sS "${h[@]}" -X POST "$G/api/auth/signup" \
  -d "{\"name\":\"Sleep Test\",\"email\":\"$email\",\"password\":\"sleep-$(openssl rand -hex 8)\"}" | jq -r '.accessToken // empty')
[ -n "$token" ] || fail "sign-up"
auth=(-H "authorization: Bearer $token")

today=$(date -u +%F)
yday=$(date -u -d "$today -1 day" +%F)
# One night: in bed 23:38 yesterday, up 08:00 today (UTC, the zone the account uses).
bed="${yday}T23:38:00Z"; wake="${today}T08:00:00Z"

# send_night DATE BEDTIME WAKE STAGES_JSON|none  (the record the phone sends)
send_night() {
  local date="$1" b="$2" w="$3" stages="$4" rec
  rec=$(jq -n --arg d "$date" --arg b "$b" --arg w "$w" --argjson st "$stages" '
    ($st | map(.duration_in_seconds) | add) as $inbed
    | { type: "SleepSession", entry_date: $d, timestamp: $b, bedtime: $b, wake_time: $w,
        duration_in_seconds: ((($w | fromdateiso8601) - ($b | fromdateiso8601))),
        time_asleep_in_seconds: 0, sleep_score: 0 }
      + (if ($st | length) > 0 then { stage_events: $st } else {} end)')
  res=$(curl -sS "${h[@]}" "${auth[@]}" -X POST "$G/api/ingest/health-connect" -d "{\"records\":[$rec]}")
  [ "$(jq -r '.errors // 1' <<<"$res")" = 0 ] || fail "ingest: $res"
}
stage() { jq -n --arg t "$1" --arg s "$2" --arg e "$3" \
  '{stage_type:$t,start_time:$s,end_time:$e,duration_in_seconds:(($e|fromdateiso8601)-($s|fromdateiso8601))}'; }

q() { # q SQL
  [ -n "${SPARKY_PSQL:-}" ] || return 1
  $SPARKY_PSQL "$1"
}
night_row() { # asleep|deep|light|rem|awake|stages  for $today
  q "select e.time_asleep_in_seconds, e.deep_sleep_seconds, e.light_sleep_seconds, e.rem_sleep_seconds, e.awake_sleep_seconds,
            (select count(*) from sleep_entry_stages s where s.entry_id = e.id)
     from sleep_entries e join \"user\" u on u.id::text = e.user_id::text
     where u.email = '$email' and e.entry_date = '$today' and e.source = 'Health Connect'"
}

# 1. Seen 36 minutes in: what the phone sends for a session with no stage data.
partial=$(jq -s . <(stage light "$bed" "${today}T00:14:00Z"))
send_night "$today" "$bed" "${today}T00:14:00Z" "$partial"
if row=$(night_row); then [ "$row" = "2160|0|2160|0|0|1" ] || fail "partial night: $row"; fi
echo "sleep-smoke: partial night stored (36 minutes)"

# 2. The whole night, with real stages. 502 minutes in bed, 10 awake: 492 asleep.
whole=$(jq -s . \
  <(stage light "$bed" "${today}T01:00:00Z") \
  <(stage deep "${today}T01:00:00Z" "${today}T02:30:00Z") \
  <(stage rem "${today}T02:30:00Z" "${today}T04:00:00Z") \
  <(stage awake "${today}T04:00:00Z" "${today}T04:10:00Z") \
  <(stage light "${today}T04:10:00Z" "$wake"))
send_night "$today" "$bed" "$wake" "$whole"
want="29520|5400|18720|5400|600|5" # asleep|deep|light|rem|awake|stage rows (the old one is gone)
if row=$(night_row); then [ "$row" = "$want" ] || fail "whole night: got $row, want $want"; echo "sleep-smoke: whole night replaced the partial one: $row"; fi

# 3. Sending it again changes nothing.
send_night "$today" "$bed" "$wake" "$whole"
if row=$(night_row); then [ "$row" = "$want" ] || fail "re-send: got $row, want $want"; echo "sleep-smoke: re-send is idempotent"; fi

# 4. What Gauntlet shows for the night (8.2 hours asleep).
for _ in $(seq 1 20); do
  curl -sS "${h[@]}" "${auth[@]}" -X POST "$G/api/me/sync" -d '{}' >/dev/null || true
  hours=$(curl -sS "${h[@]}" "${auth[@]}" "$G/api/me/day/stat?date=$today&metric=sleep" | jq -r '.value // empty')
  [ -n "$hours" ] && awk -v h="$hours" 'BEGIN{exit !(h>8.19 && h<8.21)}' && { echo "sleep-smoke: the day screen shows $hours hours asleep. OK"; exit 0; }
  sleep 3
done
fail "the day screen shows sleep=${hours:-none}, expected 8.2"
