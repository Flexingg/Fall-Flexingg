#!/bin/sh
# Exercises backup.sh against a throwaway Postgres 18 (built from deploy/postgres, so the roles and
# databases match the real stack). Uses its own network, volumes and containers, all named
# ${T:-admin-test}-*, and removes them at the end. Never touches a running stack.
#
#   sh deploy/backup/test.sh
set -eu
cd "$(dirname "$0")/.."
T=${T:-admin-test}
NET=$T-net; PG=$T-pg; BK=$T-backup
PW=testpw
cleanup() {
  docker rm -f "$PG" "$BK" > /dev/null 2>&1 || true
  docker volume rm "$T-backups" "$T-uploads" "$T-db" > /dev/null 2>&1 || true
  docker network rm "$NET" > /dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
docker network create "$NET" > /dev/null
docker volume create "$T-backups" > /dev/null
docker volume create "$T-uploads" > /dev/null
docker build -q -t "$T-postgres" postgres > /dev/null
docker build -q -t "$T-backup" backup > /dev/null

docker run -d --name "$PG" --network "$NET" --network-alias db -v "$T-db:/var/lib/postgresql" \
  -e POSTGRES_PASSWORD=$PW -e GAUNTLET_DB_PASSWORD=gpw -e SPARKY_DB_PASSWORD=spw "$T-postgres" > /dev/null
i=0; until docker exec "$PG" pg_isready -q -U postgres -h 127.0.0.1 && docker exec "$PG" psql -U postgres -Atc 'select 1 from pg_database where datname='"'sparkyfitness_db'" | grep -q 1; do
  i=$((i + 1)); [ $i -gt 60 ] && { echo "postgres did not start"; exit 1; }; sleep 1
done
sql() { docker exec "$PG" psql -U postgres -d "$1" -Atc "$2"; }

sql gauntlet "create table people(name text); insert into people values ('alice'),('bob');"
sql sparkyfitness_db "create table meals(name text); insert into meals values ('oats');"
docker run --rm -v "$T-uploads:/u" alpine sh -c 'mkdir -p /u/avatars && echo original > /u/avatars/a.txt'

# Run the service with a fast poll; the loop also takes a first backup on its own.
docker run -d --name "$BK" --network "$NET" -e POSTGRES_PASSWORD=$PW -e POLL_SECONDS=1 -e BACKUP_TIME=03:30 -e BACKUP_KEEP=2 \
  -e TZ=America/New_York -v "$T-backups:/backups" -v "$T-uploads:/uploads" "$T-backup" > /dev/null
bk() { docker exec "$BK" sh -c "$1"; }
i=0; until bk 'ls /backups/gauntlet-backup-*.tar' > /dev/null 2>&1; do i=$((i + 1)); [ $i -gt 60 ] && { docker logs "$BK"; echo "no first backup"; exit 1; }; sleep 1; done
FIRST=$(bk 'cd /backups && ls gauntlet-backup-*.tar | head -n1')
echo "first backup: $FIRST"
bk "tar -tf /backups/$FIRST" | sort | tr '\n' ' '; echo
bk "tar -xOf /backups/$FIRST manifest.json"
[ "$(bk 'cat /backups/.status/schedule.json | jq -r .time')" = "03:30" ] || { echo "schedule missing"; exit 1; }
[ -z "$(bk 'ls /backups | grep -E "^\.(partial|work)" || true')" ] || { echo "temp files left"; exit 1; }

# Change everything, then ask for a manual backup the way the API does.
sql gauntlet "insert into people values ('mallory'); delete from people where name='alice';"
sql sparkyfitness_db "drop table meals;"
docker run --rm -v "$T-uploads:/u" alpine sh -c 'echo changed > /u/avatars/a.txt; echo extra > /u/new.txt'
bk 'echo "{\"action\":\"backup\"}" > /backups/.requests/job-manual-0001.json'
i=0; until [ "$(bk 'jq -r .state /backups/.status/job-manual-0001.json 2>/dev/null' || true)" = done ]; do i=$((i + 1)); [ $i -gt 60 ] && { docker logs "$BK"; echo "manual backup did not finish"; exit 1; }; sleep 1; done
bk 'ls /backups | grep -- -manual.tar' > /dev/null || { echo "no manual backup"; exit 1; }

# Restore the FIRST backup through the request file, like the admin page.
bk "echo '{\"action\":\"restore\",\"file\":\"$FIRST\"}' > /backups/.requests/job-restore-0001.json"
i=0; until [ "$(bk 'jq -r .state /backups/.status/job-restore-0001.json' || true)" = done ] || [ "$(bk 'jq -r .state /backups/.status/job-restore-0001.json' || true)" = failed ]; do i=$((i + 1)); [ $i -gt 120 ] && { echo "restore timed out"; exit 1; }; sleep 1; done
bk 'cat /backups/.status/job-restore-0001.json'; echo
[ "$(bk 'jq -r .state /backups/.status/job-restore-0001.json')" = done ] || { docker logs "$BK" | tail -20; echo "restore failed"; exit 1; }

[ "$(sql gauntlet 'select string_agg(name, $$,$$ order by name) from people')" = "alice,bob" ] || { echo "gauntlet data not restored"; exit 1; }
[ "$(sql sparkyfitness_db 'select name from meals')" = "oats" ] || { echo "sparky data not restored"; exit 1; }
[ "$(docker run --rm -v "$T-uploads:/u" alpine cat /u/avatars/a.txt)" = "original" ] || { echo "uploads not restored"; exit 1; }
docker run --rm -v "$T-uploads:/u" alpine test ! -e /u/new.txt || { echo "stale upload left behind"; exit 1; }
bk 'ls /backups | grep -- -pre-restore.tar' > /dev/null || { echo "no safety backup"; exit 1; }
# The safety backup holds the state from just before the restore (mallory).
PRE=$(bk 'cd /backups && ls gauntlet-backup-*-pre-restore.tar | head -n1')
[ -n "$PRE" ] || exit 1

# A failing restore (corrupt file) must change nothing.
bk 'cd /backups && head -c 3000 '"$FIRST"' > gauntlet-backup-20200101-000000-uploaded.tar'
bk 'echo "{\"action\":\"restore\",\"file\":\"gauntlet-backup-20200101-000000-uploaded.tar\"}" > /backups/.requests/job-restore-0002.json'
i=0; until [ "$(bk 'jq -r .state /backups/.status/job-restore-0002.json' || true)" = failed ]; do i=$((i + 1)); [ $i -gt 30 ] && { echo "bad restore did not fail"; exit 1; }; sleep 1; done
bk 'jq -r .message /backups/.status/job-restore-0002.json'
[ "$(sql gauntlet 'select count(*) from people')" = "2" ] || { echo "data changed by failed restore"; exit 1; }

echo "PASS: backup, restore, safety backup, failed-restore, and pruning paths all behaved"
