#!/usr/bin/env bash
# Deploy Gauntlet on this machine and publish an APK.
#
#   deploy/hermes/deploy.sh <version> <path-to-apk> [--skip-build]
#
# Run by the release workflow on the hermes-pc runner, or by hand. Safe to re-run.
# Config comes from /opt/gauntlet/.env (override with GAUNTLET_ENV_FILE).
set -euo pipefail

VERSION="${1:?usage: deploy.sh <version> <apk-path>}"
APK="${2:?usage: deploy.sh <version> <apk-path>}"
SKIP_BUILD="${3:-}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT/deploy/hermes/docker-compose.yml"
ENV_FILE="${GAUNTLET_ENV_FILE:-/opt/gauntlet/.env}"
DOWNLOADS="${GAUNTLET_DOWNLOADS_DIR:-/opt/gauntlet/downloads}"
IMAGE="${GAUNTLET_IMAGE:-gauntlet}"
KEEP_IMAGES=3
KEEP_APKS=5

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "version '$VERSION' has characters that aren't safe in a file name"
[[ -f "$APK" ]] || die "APK not found: $APK"
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE not found. Copy deploy/hermes/.env.example there and fill it in."
command -v docker >/dev/null || die "docker is not installed or not on PATH"

set -a; source "$ENV_FILE"; set +a
for v in POSTGRES_PASSWORD JWT_SECRET ENCRYPTION_KEY PUBLIC_WEB_URL; do
  [[ -n "${!v:-}" ]] || die "$v is empty in $ENV_FILE"
done
export GAUNTLET_DOWNLOADS_DIR="$DOWNLOADS"
PORT="${GAUNTLET_PORT:-3333}"
compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

# ---- 1. Publish the APK. latest.json goes last, so the app never advertises a file that isn't there.
log "Publishing APK $VERSION"
mkdir -p "$DOWNLOADS"
APK_NAME="gauntlet-$VERSION.apk"
SHA="$(sha256sum "$APK" | cut -d' ' -f1)"
SIZE="$(stat -c %s "$APK")"
PREV_JSON=""
[[ -f "$DOWNLOADS/latest.json" ]] && PREV_JSON="$(cat "$DOWNLOADS/latest.json")"
install -m 644 "$APK" "$DOWNLOADS/$APK_NAME.tmp" && mv -f "$DOWNLOADS/$APK_NAME.tmp" "$DOWNLOADS/$APK_NAME"
install -m 644 "$APK" "$DOWNLOADS/gauntlet-latest.apk.tmp" && mv -f "$DOWNLOADS/gauntlet-latest.apk.tmp" "$DOWNLOADS/gauntlet-latest.apk"
write_latest() {
  printf '{"version":"%s","builtAt":"%s","sha256":"%s","file":"%s","sizeBytes":%s}\n' \
    "$VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SHA" "$APK_NAME" "$SIZE" > "$DOWNLOADS/latest.json.tmp"
  chmod 644 "$DOWNLOADS/latest.json.tmp"; mv -f "$DOWNLOADS/latest.json.tmp" "$DOWNLOADS/latest.json"
}

# ---- 2. Build the web + API image.
if docker image inspect "$IMAGE:deployed" >/dev/null 2>&1; then
  docker tag "$IMAGE:deployed" "$IMAGE:previous"
fi
if [[ "$SKIP_BUILD" != "--skip-build" ]]; then
  log "Building image $IMAGE:$VERSION"
  docker build -t "$IMAGE:$VERSION" "$ROOT"
fi
docker tag "$IMAGE:$VERSION" "$IMAGE:deployed"

# ---- 3. Start it, and put the old version back if it doesn't come up healthy.
log "Starting on port $PORT"
compose up -d --remove-orphans
healthy() { curl -fsS -m 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; }
for _ in $(seq 1 60); do healthy && break; sleep 1; done
if ! healthy; then
  echo "--- gauntlet logs ---"; compose logs --tail 60 gauntlet || true
  if docker image inspect "$IMAGE:previous" >/dev/null 2>&1; then
    log "New version did not become healthy; rolling back"
    docker tag "$IMAGE:previous" "$IMAGE:deployed"
    compose up -d --remove-orphans || true
    # Put the previously published APK back as "latest", and drop the one that didn't ship.
    PREV_FILE="$(printf '%s' "$PREV_JSON" | sed -n 's/.*"file":"\([^"]*\)".*/\1/p')"
    if [[ -n "$PREV_FILE" && -f "$DOWNLOADS/$PREV_FILE" ]]; then
      install -m 644 "$DOWNLOADS/$PREV_FILE" "$DOWNLOADS/gauntlet-latest.apk.tmp" && mv -f "$DOWNLOADS/gauntlet-latest.apk.tmp" "$DOWNLOADS/gauntlet-latest.apk"
      printf '%s\n' "$PREV_JSON" > "$DOWNLOADS/latest.json"
    fi
    [[ "$PREV_FILE" != "$APK_NAME" ]] && rm -f "$DOWNLOADS/$APK_NAME"
  fi
  die "deploy of $VERSION failed"
fi

write_latest
SERVED="$(curl -fsS -m 5 "http://127.0.0.1:$PORT/api/app/android" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
[[ "$SERVED" == "$VERSION" ]] || die "app reports version '$SERVED', expected '$VERSION'"

# ---- 4. Tidy up old builds.
docker images "$IMAGE" --format '{{.Tag}}' | grep -E '^[A-Za-z0-9]' | grep -vE '^(deployed|previous|latest)$' | sort -Vr | tail -n +$((KEEP_IMAGES + 1)) \
  | while read -r tag; do docker rmi "$IMAGE:$tag" >/dev/null 2>&1 || true; done
ls -1t "$DOWNLOADS"/gauntlet-*.apk 2>/dev/null | grep -v 'gauntlet-latest.apk' | tail -n +$((KEEP_APKS + 1)) | xargs -r rm -f

log "Gauntlet $VERSION is live on http://localhost:$PORT  (APK: /downloads/gauntlet-latest.apk)"
