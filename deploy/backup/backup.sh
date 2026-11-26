#!/bin/sh
# Gauntlet backup service. Runs forever (`backup.sh loop`): takes automatic backups on a schedule
# (off / hourly / daily / weekly / monthly, set on the admin page and saved in
# $BACKUPS/.config/schedule.json; BACKUP_* env vars are the defaults), deletes old ones by count and
# by age, and does the backups/restores the admin page (or `backup.sh restore FILE`) asks for.
#
# A backup is one tar in $BACKUPS: manifest.json, globals.sql, gauntlet.dump, sparkyfitness_db.dump
# and sparky-uploads.tar.gz. Requests arrive as $BACKUPS/.requests/<id>.json, progress goes to
# $BACKUPS/.status/<id>.json. One job at a time.
set -u

BACKUPS=${BACKUPS:-/backups}
UPLOADS=${UPLOADS:-/uploads}
PGHOST=${PGHOST:-db}
PGUSER=${PGUSER:-postgres}
PGPASSWORD=${PGPASSWORD:-${POSTGRES_PASSWORD:-}}
export PGHOST PGUSER PGPASSWORD
DATABASES="gauntlet sparkyfitness_db"
# Defaults until an admin saves a schedule.
BACKUP_FREQUENCY=${BACKUP_FREQUENCY:-daily}
BACKUP_TIME=${BACKUP_TIME:-03:30}
BACKUP_WEEKDAY=${BACKUP_WEEKDAY:-0}
BACKUP_DAY_OF_MONTH=${BACKUP_DAY_OF_MONTH:-1}
BACKUP_KEEP=${BACKUP_KEEP:-14}
BACKUP_KEEP_DAYS=${BACKUP_KEEP_DAYS:-0}
MANUAL_KEEP=20
CONFIG=$BACKUPS/.config/schedule.json
POLL_SECONDS=${POLL_SECONDS:-5}
REQ=$BACKUPS/.requests
STATUS=$BACKUPS/.status

log() { echo "[backup $(date '+%Y-%m-%d %H:%M:%S')] $*"; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Write a JSON file atomically (temp + rename) so a reader never sees half of it.
write_json() { # file, jq args...
  wj_f=$1; shift
  jq -n "$@" > "$wj_f.tmp" && chmod 644 "$wj_f.tmp" && mv "$wj_f.tmp" "$wj_f"
}

# write_status ID ACTION STATE MESSAGE FILE STARTED FINISHED
write_status() {
  write_json "$STATUS/$1.json" --arg id "$1" --arg action "$2" --arg state "$3" --arg message "$4" \
    --arg file "$5" --arg started "$6" --arg finished "$7" \
    '{id:$id, action:$action, state:$state, message:$message,
      file:(if $file=="" then null else $file end),
      startedAt:(if $started=="" then null else $started end),
      finishedAt:(if $finished=="" then null else $finished end)}'
  if [ "$3" = running ]; then
    cp "$STATUS/$1.json" "$STATUS/current.json.tmp" && mv "$STATUS/current.json.tmp" "$STATUS/current.json"
  fi
}

# Plain-English progress for the admin page.
progress() { write_status "$JOB_ID" "$JOB_ACTION" running "$1" "$JOB_FILE" "$JOB_STARTED" ""; log "$1"; }

wait_for_db() {
  i=0
  until pg_isready -q -h "$PGHOST" -U "$PGUSER"; do
    i=$((i + 1)); [ "$i" -gt 60 ] && return 1
    sleep 2
  done
}

# do_backup SUFFIX  ("" | -manual | -pre-restore). Sets BACKUP_FILE; on failure returns 1 with ERR set.
do_backup() {
  suffix=$1
  ts=$(date +%Y%m%d-%H%M%S)
  BACKUP_FILE=gauntlet-backup-$ts$suffix.tar
  bwork=$BACKUPS/.work-backup-$ts
  partial=$BACKUPS/.partial-$BACKUP_FILE
  rm -rf "$bwork"; mkdir -p "$bwork"
  ERR=""
  progress "Saving accounts and settings"
  if ! pg_dumpall --globals-only > "$bwork/globals.sql" 2> "$bwork/err"; then
    ERR="Could not read the database roles: $(tail -n1 "$bwork/err")"
  fi
  for bdb in $DATABASES; do
    [ -z "$ERR" ] || break
    progress "Saving the $bdb database"
    if ! pg_dump -Fc -d "$bdb" -f "$bwork/$bdb.dump" 2> "$bwork/err"; then
      ERR="Could not save $bdb: $(tail -n1 "$bwork/err")"
    fi
  done
  if [ -z "$ERR" ]; then
    progress "Saving uploaded files"
    if ! tar -czf "$bwork/sparky-uploads.tar.gz" -C "$UPLOADS" . 2> "$bwork/err"; then
      ERR="Could not save the uploads folder: $(tail -n1 "$bwork/err")"
    fi
  fi
  if [ -z "$ERR" ]; then
    app_version=$(cat "$BACKUPS/.app-version" 2>/dev/null || echo unknown)
    pg_version=$(psql -Atc 'show server_version' -d postgres 2>/dev/null || echo unknown)
    sz() { wc -c < "$bwork/$1" | tr -d ' '; }
    jq -n --arg created "$(now_iso)" --arg pg "$pg_version" --arg app "$app_version" --arg kind "${suffix#-}" \
      --argjson g "$(sz gauntlet.dump)" --argjson s "$(sz sparkyfitness_db.dump)" \
      --argjson u "$(sz sparky-uploads.tar.gz)" --argjson r "$(sz globals.sql)" \
      '{created:$created, postgresVersion:$pg, appVersion:$app, kind:(if $kind=="" then "auto" else $kind end),
        sizes:{globals:$r, gauntlet:$g, sparkyfitness_db:$s, uploads:$u}}' > "$bwork/manifest.json"
    progress "Packing the backup"
    if tar -cf "$partial" -C "$bwork" manifest.json globals.sql gauntlet.dump sparkyfitness_db.dump sparky-uploads.tar.gz 2> "$bwork/err"; then
      chmod 644 "$partial"
      mv "$partial" "$BACKUPS/$BACKUP_FILE"
    else
      ERR="Could not write the backup file (is the disk full?): $(tail -n1 "$bwork/err")"
    fi
  fi
  rm -rf "$bwork"
  if [ -n "$ERR" ]; then rm -f "$partial"; return 1; fi
  bytes=$(wc -c < "$BACKUPS/$BACKUP_FILE" | tr -d ' ')
  write_json "$STATUS/last-backup.json" --arg f "$BACKUP_FILE" --argjson b "$bytes" --arg c "$(now_iso)" \
    '{file:$f, sizeBytes:$b, createdAt:$c}'
  prune
  return 0
}

# Keep the newest KEEP_COUNT automatic backups (0 = no limit) and MANUAL_KEEP manual ones, then
# apply the age limit. Uploaded backups stay until someone deletes them.
prune() {
  [ "$KEEP_COUNT" -gt 0 ] && keep_newest "gauntlet-backup-????????-??????.tar" "$KEEP_COUNT"
  keep_newest "gauntlet-backup-????????-??????-manual.tar" "$MANUAL_KEEP"
  prune_by_age
  return 0
}
# Delete automatic, manual and pre-restore backups older than KEEP_DAYS days, but never the newest
# backup of all (so there is always one to restore). Uploaded backups are left to the admin.
prune_by_age() {
  [ "$KEEP_DAYS" -gt 0 ] || return 0
  newest=$(ls -1 "$BACKUPS"/gauntlet-backup-*.tar 2>/dev/null | sort | tail -n 1)
  find "$BACKUPS" -maxdepth 1 -name 'gauntlet-backup-*.tar' ! -name '*-uploaded.tar' \
    -mmin +$((KEEP_DAYS * 1440)) 2>/dev/null | while read -r old; do
    [ "$old" = "$newest" ] && continue
    log "Removing $(basename "$old") (older than $KEEP_DAYS days)"; rm -f "$old"
  done
}
keep_newest() { # glob, how many to keep
  ls -1 "$BACKUPS"/$1 2>/dev/null | sort -r | tail -n +"$(($2 + 1))" | while read -r old; do
    log "Removing old backup $(basename "$old")"; rm -f "$old"
  done
}

valid_backup_name() {
  case $1 in
    gauntlet-backup-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9].tar | \
    gauntlet-backup-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]-manual.tar | \
    gauntlet-backup-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]-pre-restore.tar | \
    gauntlet-backup-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]-uploaded.tar) return 0 ;;
  esac
  return 1
}

# do_restore FILE. Takes a safety backup first. Each database is restored in one transaction, so a
# failure leaves that database as it was. Sets ERR (failure) or RESULT_MSG (success).
do_restore() {
  rwork=$BACKUPS/.work-restore
  rm -rf "$rwork"; mkdir -p "$rwork/uploads"
  restore_inner "$1"
  rrc=$?
  rm -rf "$rwork"
  return $rrc
}

restore_inner() {
  rfile=$1
  ERR=""
  if ! valid_backup_name "$rfile" || [ ! -f "$BACKUPS/$rfile" ]; then ERR="That backup does not exist"; return 1; fi
  progress "Checking the backup"
  if ! tar -xf "$BACKUPS/$rfile" -C "$rwork" 2> "$rwork/err"; then ERR="The backup file is damaged: $(tail -n1 "$rwork/err")"; return 1; fi
  for part in manifest.json globals.sql gauntlet.dump sparkyfitness_db.dump sparky-uploads.tar.gz; do
    [ -f "$rwork/$part" ] || { ERR="The backup is missing $part"; return 1; }
  done
  for rdb in $DATABASES; do
    pg_restore -l "$rwork/$rdb.dump" > /dev/null 2> "$rwork/err" || { ERR="The $rdb part of the backup cannot be read: $(tail -n1 "$rwork/err")"; return 1; }
  done
  tar -tzf "$rwork/sparky-uploads.tar.gz" > /dev/null 2>&1 || { ERR="The uploads part of the backup cannot be read"; return 1; }

  progress "Taking a safety backup of the current data first"
  if ! do_backup -pre-restore; then ERR="Could not take the safety backup, so nothing was changed. $ERR"; return 1; fi
  safety=$BACKUP_FILE

  # Roles: create the missing ones. Roles that already exist keep their current passwords (the .env
  # file is the truth), so a restore can never lock the stack out of Postgres.
  progress "Restoring accounts and settings"
  psql -Atc "select rolname from pg_roles" -d postgres > "$rwork/roles" 2>/dev/null
  awk 'NR==FNR { have[$0]=1; next }
       /^ALTER ROLE / && ($3 in have) { sub(/ PASSWORD .*;$/, ";") }
       { print }' "$rwork/roles" "$rwork/globals.sql" > "$rwork/globals.filtered.sql"
  # "already exists" errors for roles are expected and ignored.
  psql -d postgres -q -f "$rwork/globals.filtered.sql" > /dev/null 2> "$rwork/globals.err" || true

  restored=""
  for rdb in $DATABASES; do
    progress "Restoring the $rdb database"
    psql -d postgres -Atc "select pg_terminate_backend(pid) from pg_stat_activity where datname='$rdb' and pid <> pg_backend_pid()" > /dev/null 2>&1
    if ! pg_restore --clean --if-exists --single-transaction --no-password -d "$rdb" "$rwork/$rdb.dump" > /dev/null 2> "$rwork/err"; then
      detail=$(grep -i 'error' "$rwork/err" | head -n2 | tr '\n' ' ')
      ERR="Restoring $rdb failed, so it was left as it was (already restored:${restored:- none}). A safety backup is saved as $safety. Reason: $detail"
      return 1
    fi
    restored="$restored $rdb"
  done

  progress "Restoring uploaded files"
  mkdir -p "$UPLOADS"
  if ! tar -xzf "$rwork/sparky-uploads.tar.gz" -C "$rwork/uploads" 2> "$rwork/err"; then
    ERR="Databases are restored but the uploads could not be unpacked: $(tail -n1 "$rwork/err"). Safety backup: $safety"; return 1
  fi
  find "$UPLOADS" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null
  if ! cp -a "$rwork/uploads/." "$UPLOADS/" 2> "$rwork/err"; then
    ERR="Databases are restored but copying the uploads failed: $(tail -n1 "$rwork/err"). Safety backup: $safety"; return 1
  fi
  RESULT_MSG="Restored from $rfile. Restart the stack now. A safety backup of what was there before is saved as $safety."
  return 0
}

# Run one request file.
handle_request() {
  rf=$1
  JOB_ID=$(basename "$rf" .json)
  case $JOB_ID in *[!A-Za-z0-9-]* | "") rm -f "$rf"; return ;; esac
  JOB_ACTION=$(jq -r '.action // ""' "$rf" 2>/dev/null)
  JOB_FILE=$(jq -r '.file // ""' "$rf" 2>/dev/null)
  JOB_STARTED=$(now_iso)
  rm -f "$rf"
  RESULT_MSG=""
  case $JOB_ACTION in
    backup)
      JOB_FILE=""
      progress "Starting"
      if do_backup -manual; then
        write_status "$JOB_ID" backup done "Backup saved" "$BACKUP_FILE" "$JOB_STARTED" "$(now_iso)"
      else
        log "Backup failed: $ERR"
        write_status "$JOB_ID" backup failed "$ERR" "" "$JOB_STARTED" "$(now_iso)"
      fi ;;
    restore)
      progress "Starting"
      if do_restore "$JOB_FILE"; then
        write_status "$JOB_ID" restore done "$RESULT_MSG" "$JOB_FILE" "$JOB_STARTED" "$(now_iso)"
      else
        log "Restore failed: $ERR"
        write_status "$JOB_ID" restore failed "$ERR" "$JOB_FILE" "$JOB_STARTED" "$(now_iso)"
      fi ;;
    *) write_status "$JOB_ID" "${JOB_ACTION:-unknown}" failed "Unknown request" "" "$JOB_STARTED" "$(now_iso)" ;;
  esac
  rm -f "$STATUS/current.json"
}

setup_dirs() {
  mkdir -p "$REQ" "$STATUS" "$BACKUPS/.config"
  # The Gauntlet API runs as the image's `node` user (uid 1000) and needs to write requests and
  # delete backups. Give that user the folders rather than opening them to everyone.
  chown "${API_UID:-1000}:${API_UID:-1000}" "$BACKUPS" "$REQ" "$STATUS" "$BACKUPS/.config" 2>/dev/null
  chmod 770 "$BACKUPS" "$REQ" "$STATUS" "$BACKUPS/.config" 2>/dev/null
  return 0
}

# Read the admin's schedule (or the env defaults) into FREQ TIME WEEKDAY DOM KEEP_COUNT KEEP_DAYS.
# Anything invalid falls back to the default for that field.
load_config() {
  FREQ=$BACKUP_FREQUENCY; TIME=$BACKUP_TIME; WEEKDAY=$BACKUP_WEEKDAY; DOM=$BACKUP_DAY_OF_MONTH
  KEEP_COUNT=$BACKUP_KEEP; KEEP_DAYS=$BACKUP_KEEP_DAYS; CONFIG_SOURCE=env
  if [ -f "$CONFIG" ] && jq -e . "$CONFIG" > /dev/null 2>&1; then
    CONFIG_SOURCE=admin
    v=$(jq -r '.frequency // empty' "$CONFIG"); [ -n "$v" ] && FREQ=$v
    v=$(jq -r '.time // empty' "$CONFIG"); [ -n "$v" ] && TIME=$v
    v=$(jq -r '.weekday // empty' "$CONFIG"); [ -n "$v" ] && WEEKDAY=$v
    v=$(jq -r '.dayOfMonth // empty' "$CONFIG"); [ -n "$v" ] && DOM=$v
    v=$(jq -r '.keepCount // empty' "$CONFIG"); [ -n "$v" ] && KEEP_COUNT=$v
    v=$(jq -r '.keepDays // empty' "$CONFIG"); [ -n "$v" ] && KEEP_DAYS=$v
  fi
  case $FREQ in off | hourly | daily | weekly | monthly) ;; *) FREQ=daily ;; esac
  case $TIME in [0-2][0-9]:[0-5][0-9]) ;; *) TIME=03:30 ;; esac
  case $WEEKDAY in [0-6]) ;; *) WEEKDAY=0 ;; esac
  case $DOM in [1-9] | 1[0-9] | 2[0-8]) ;; *) DOM=1 ;; esac
  case $KEEP_COUNT in '' | *[!0-9]*) KEEP_COUNT=14 ;; esac
  case $KEEP_DAYS in '' | *[!0-9]*) KEEP_DAYS=0 ;; esac
}
config_signature() { echo "$FREQ $TIME $WEEKDAY $DOM $KEEP_COUNT $KEEP_DAYS"; }

at_time_on() { date -d "$1 $TIME:00" +%s; } # YYYY-MM-DD -> epoch at TIME that day (in TZ)

# Epoch of the next automatic backup, or 0 when they're off.
next_run() {
  n=$(date +%s)
  case $FREQ in
    off) echo 0; return ;;
    hourly)
      t=$(date -d "$(date +%Y-%m-%d) $(date +%H):${TIME#*:}:00" +%s)
      [ "$t" -le "$n" ] && t=$((t + 3600))
      echo "$t"; return ;;
  esac
  i=0
  while [ "$i" -le 62 ]; do
    d=$(date -d "@$((n + i * 86400))" +%Y-%m-%d)
    t=$(at_time_on "$d")
    if [ "$t" -gt "$n" ]; then
      case $FREQ in
        daily) echo "$t"; return ;;
        weekly) [ "$(date -d "$d 12:00:00" +%w)" = "$WEEKDAY" ] && { echo "$t"; return; } ;;
        monthly) [ "$(date -d "$d 12:00:00" +%d | sed 's/^0//')" = "$DOM" ] && { echo "$t"; return; } ;;
      esac
    fi
    i=$((i + 1))
  done
  echo 0
}
write_schedule() {
  if [ "$NEXT" -gt 0 ]; then at=$(date -u -d "@$NEXT" +%Y-%m-%dT%H:%M:%SZ); else at=""; fi
  write_json "$STATUS/schedule.json" --arg at "$at" --arg frequency "$FREQ" --arg time "$TIME" \
    --argjson weekday "$WEEKDAY" --argjson dayOfMonth "$DOM" --argjson keepCount "$KEEP_COUNT" \
    --argjson keepDays "$KEEP_DAYS" --arg source "$CONFIG_SOURCE" \
    '{nextAt:(if $at=="" then null else $at end), keep:$keepCount, frequency:$frequency, time:$time,
      weekday:$weekday, dayOfMonth:$dayOfMonth, keepCount:$keepCount, keepDays:$keepDays, source:$source}'
}
# Re-read the schedule; when it changed, work out the next run again and tidy up under the new rules.
refresh_config() {
  load_config
  sig=$(config_signature)
  [ "$sig" = "${CONFIG_SIG:-}" ] && return 0
  CONFIG_SIG=$sig
  NEXT=$(next_run); write_schedule
  if [ "$NEXT" -gt 0 ]; then
    log "Schedule: $FREQ at $TIME, keeping $KEEP_COUNT (0 = all), max age $KEEP_DAYS days (0 = no limit). Next: $(date -d "@$NEXT")"
  else
    log "Automatic backups are off (keeping $KEEP_COUNT, max age $KEEP_DAYS days)"
  fi
  prune
}

# An automatic (scheduled or first-ever) backup.
auto_backup() {
  JOB_ID=auto-$(date +%s); JOB_ACTION=backup; JOB_FILE=""; JOB_STARTED=$(now_iso)
  if do_backup ""; then
    write_status "$JOB_ID" backup done "Backup saved" "$BACKUP_FILE" "$JOB_STARTED" "$(now_iso)"
  else
    log "Automatic backup failed: $ERR"
    write_status "$JOB_ID" backup failed "$ERR" "" "$JOB_STARTED" "$(now_iso)"
  fi
  rm -f "$STATUS/current.json"
}

loop() {
  setup_dirs
  log "Waiting for the database"
  wait_for_db || { log "The database never became ready"; exit 1; }
  refresh_config
  log "Ready."
  # A fresh install has no backup yet; take one now rather than waiting for the first run.
  if ! ls "$BACKUPS"/gauntlet-backup-*.tar > /dev/null 2>&1; then auto_backup; fi
  LAST_PRUNE=$(date +%s)
  while true; do
    write_json "$STATUS/heartbeat.json" --argjson at "$(date +%s)" '{at:$at}'
    refresh_config
    # Age limits apply even when nothing new is taken; check every 10 minutes.
    if [ $(( $(date +%s) - LAST_PRUNE )) -ge 600 ]; then prune; LAST_PRUNE=$(date +%s); fi
    for rf in "$REQ"/*.json; do
      [ -e "$rf" ] || continue
      handle_request "$rf"
    done
    if [ "$NEXT" -gt 0 ] && [ "$(date +%s)" -ge "$NEXT" ]; then
      auto_backup
      NEXT=$(next_run); write_schedule
    fi
    sleep "$POLL_SECONDS"
  done
}

case ${1:-loop} in
  loop) loop ;;
  # One-off from the command line: backup.sh now | backup.sh restore FILE
  now)
    setup_dirs; load_config; wait_for_db || exit 1
    JOB_ID=cli; JOB_ACTION=backup; JOB_FILE=""; JOB_STARTED=$(now_iso)
    if do_backup -manual; then echo "Saved $BACKUPS/$BACKUP_FILE"; else echo "Failed: $ERR"; exit 1; fi ;;
  restore)
    setup_dirs; load_config; wait_for_db || exit 1
    JOB_ID=cli; JOB_ACTION=restore; JOB_FILE=$(basename "${2:?usage: backup.sh restore FILE}"); JOB_STARTED=$(now_iso)
    if do_restore "$JOB_FILE"; then echo "$RESULT_MSG"; else echo "Failed: $ERR"; exit 1; fi ;;
  # Apply the keep-count and age limits now (they also run on their own every 10 minutes).
  prune)
    setup_dirs; load_config; prune ;;
  # Print when the next automatic backup would run under the current schedule (for checking).
  next)
    load_config; NEXT=$(next_run)
    if [ "$NEXT" -gt 0 ]; then date -d "@$NEXT" '+%a %Y-%m-%d %H:%M'; else echo off; fi ;;
  *) echo "usage: backup.sh [loop|now|restore FILE|next|prune]"; exit 2 ;;
esac
