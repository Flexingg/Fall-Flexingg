#!/usr/bin/env bash
# Checks that this machine is ready to run Gauntlet, and says how to fix anything that isn't.
#
#   deploy/hermes/preflight.sh
#
# Run by deploy.sh before every deploy, and by the "Hermes check" workflow on its own. Changes nothing
# except creating the downloads folder. Secrets are never printed.
set -uo pipefail

ENV_FILE="${GAUNTLET_ENV_FILE:-/opt/gauntlet/.env}"
BASE_DIR="$(dirname "$ENV_FILE")"
DOWNLOADS="${GAUNTLET_DOWNLOADS_DIR:-$BASE_DIR/downloads}"
ME="$(id -un)"
FAILS=0
WARNS=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; WARNS=$((WARNS + 1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; shift; for l in "$@"; do printf '      %s\n' "$l"; done; FAILS=$((FAILS + 1)); }
section() { printf '\n\033[1m%s\033[0m\n' "$*"; }

section "Tools (running as $ME)"
for t in curl git sha256sum stat; do
  command -v "$t" >/dev/null && ok "$t found" || bad "$t is not installed" "Install it, e.g. sudo apt install $t"
done

section "Docker"
if ! command -v docker >/dev/null; then
  bad "docker is not installed" "Install Docker Engine: https://docs.docker.com/engine/install/"
elif ! docker info >/dev/null 2>&1; then
  bad "Docker is installed but '$ME' can't use it" \
      "If the error is 'permission denied': sudo usermod -aG docker $ME" \
      "then restart the runner service so it picks up the new group:" \
      "  cd <runner folder> && sudo ./svc.sh stop && sudo ./svc.sh start" \
      "If the daemon is not running: sudo systemctl enable --now docker"
else
  ok "Docker daemon reachable ($(docker version --format '{{.Server.Version}}' 2>/dev/null))"
  docker compose version >/dev/null 2>&1 \
    && ok "docker compose plugin present ($(docker compose version --short 2>/dev/null))" \
    || bad "docker compose plugin is missing" "Install it: sudo apt install docker-compose-plugin"
  root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)"
  if [[ -n "$root" && -d "$root" ]] && avail="$(df -Pk "$root" 2>/dev/null | awk 'NR==2{print $4}')" && [[ -n "$avail" ]]; then
    (( avail > 3 * 1024 * 1024 )) && ok "Docker storage has $((avail / 1024 / 1024)) GB free" \
      || bad "Docker storage ($root) has under 3 GB free" "Free some space: docker system prune -af (this removes unused images)"
  fi
fi

section "Folders ($BASE_DIR)"
if [[ ! -d "$BASE_DIR" ]]; then
  bad "$BASE_DIR does not exist" "sudo mkdir -p $BASE_DIR && sudo chown -R $ME $BASE_DIR"
elif [[ ! -w "$BASE_DIR" ]]; then
  bad "$ME can't write to $BASE_DIR" "sudo chown -R $ME $BASE_DIR"
else
  ok "$BASE_DIR is writable"
  if mkdir -p "$DOWNLOADS" 2>/dev/null && probe="$(mktemp "$DOWNLOADS/.probe.XXXXXX" 2>/dev/null)"; then
    rm -f "$probe"; ok "downloads folder ready ($DOWNLOADS)"
  else
    bad "can't write to $DOWNLOADS" "sudo mkdir -p $DOWNLOADS && sudo chown -R $ME $DOWNLOADS"
  fi
fi

section "Settings ($ENV_FILE)"
if [[ ! -f "$ENV_FILE" ]]; then
  bad "$ENV_FILE does not exist" "cp deploy/hermes/.env.example $ENV_FILE && chmod 600 $ENV_FILE, then fill it in"
elif [[ ! -r "$ENV_FILE" ]]; then
  bad "$ME can't read $ENV_FILE" "sudo chown $ME $ENV_FILE"
else
  ok "file found"
  mode="$(stat -c %a "$ENV_FILE")"
  [[ "${mode: -1}" == "0" ]] && ok "not readable by other users (mode $mode)" \
    || warn "$ENV_FILE is readable by other users (mode $mode). Run: chmod 600 $ENV_FILE"
  # Read the values in a subshell so nothing leaks into this script's environment.
  vals="$(set -a; source "$ENV_FILE" >/dev/null 2>&1; set +a
          printf 'POSTGRES_PASSWORD=%s\nJWT_LEN=%s\nPUBLIC_WEB_URL=%s\nSPARKY_URL=%s\nPORT=%s\nKEY_LEN=%s\n' \
            "${POSTGRES_PASSWORD:+set}" "${#JWT_SECRET}" "${PUBLIC_WEB_URL:-}" "${SPARKY_URL:-https://fit.randalls.cc}" \
            "${GAUNTLET_PORT:-3333}" "$(printf '%s' "${ENCRYPTION_KEY:-}" | base64 -d 2>/dev/null | wc -c)")"
  get() { sed -n "s/^$1=//p" <<<"$vals"; }
  [[ "$(get POSTGRES_PASSWORD)" == "set" ]] && ok "POSTGRES_PASSWORD set" || bad "POSTGRES_PASSWORD is empty" "openssl rand -base64 24"
  (( $(get JWT_LEN) >= 32 )) && ok "JWT_SECRET is long enough" || bad "JWT_SECRET is missing or shorter than 32 characters" "openssl rand -base64 48"
  [[ "$(get KEY_LEN)" == "32" ]] && ok "ENCRYPTION_KEY is a valid 32-byte key" \
    || bad "ENCRYPTION_KEY is missing or not 32 bytes of base64" "openssl rand -base64 32" "(keep it stable: changing it signs everyone out)"
  url="$(get PUBLIC_WEB_URL)"
  if [[ "$url" == https://* && "$url" != *example.com* ]]; then ok "PUBLIC_WEB_URL = $url"
  elif [[ -z "$url" || "$url" == *example.com* ]]; then bad "PUBLIC_WEB_URL is not set to your real address" "Set it to the https URL Cloudflare serves, e.g. https://gauntlet.yourdomain.com"
  else bad "PUBLIC_WEB_URL must start with https:// (got $url)" "Cloudflare terminates TLS; Gauntlet's cookies and invite links need the https address"; fi
  PORT="$(get PORT)"; SPARKY="$(get SPARKY_URL)"
fi
PORT="${PORT:-3333}"

section "Network"
owner="$(docker ps --filter "publish=$PORT" --format '{{.Names}}' 2>/dev/null | head -1)"
if [[ "$owner" == gauntlet-* ]]; then ok "port $PORT is Gauntlet's (a previous version is running; it will be replaced)"
elif [[ -n "$owner" ]]; then bad "port $PORT is used by the container '$owner'" "Stop it, or set GAUNTLET_PORT in $ENV_FILE and update your Cloudflare tunnel"
elif (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  # A plain connect works everywhere, with no extra tools needed.
  bad "port $PORT is already in use by another program" "Find it with: sudo lsof -iTCP:$PORT -sTCP:LISTEN   (or: sudo ss -ltnp 'sport = :$PORT')"
else ok "port $PORT is free"; fi
code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' https://registry-1.docker.io/v2/ 2>/dev/null)"
case "$code" in 200|401) ok "Docker Hub reachable (needed to build)";; 429) warn "Docker Hub is rate limiting this machine (HTTP 429). Builds may fail; log in with 'docker login'";; *) bad "can't reach Docker Hub (HTTP ${code:-none})" "Check the machine's internet/DNS/proxy";; esac
if [[ -n "${SPARKY:-}" ]]; then
  code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$SPARKY/api/health" 2>/dev/null)"
  [[ "$code" == "200" ]] && ok "SparkyFitness reachable at $SPARKY" || warn "SparkyFitness at $SPARKY answered HTTP ${code:-none}; Gauntlet will start but can't sync until it does"
fi

echo
if (( FAILS > 0 )); then
  printf '\033[1;31m%d problem(s) to fix before Gauntlet can deploy here.\033[0m\n' "$FAILS"; exit 1
fi
printf '\033[1;32mReady.\033[0m%s\n' "$( (( WARNS > 0 )) && echo " ($WARNS warning(s) above)")"
