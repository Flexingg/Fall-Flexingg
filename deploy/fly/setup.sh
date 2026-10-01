#!/usr/bin/env bash
# One-time (and safe to re-run) Fly.io setup for Gauntlet + its SparkyFitness:
#   - creates the four apps if they don't exist
#   - generates every secret that isn't set yet and stores it straight in Fly (never printed)
#   - registers the custom domains and prints the DNS records to add in Cloudflare
# Then run deploy.sh (the "Fly setup" workflow does both).
#
#   FLY_API_TOKEN=... FLY_APP_PREFIX=gauntlet GAUNTLET_PUBLIC_URL=https://... \
#     SPARKY_PUBLIC_URL=https://... deploy/fly/setup.sh
source "$(dirname "$0")/common.sh"
ORG="${FLY_ORG:-personal}"
need() { command -v "$1" >/dev/null || { echo "setup: needs $1" >&2; exit 2; }; }
need jq; need openssl; need "$FLY"

log "Apps (org: $ORG, region: $REGION)"
existing="$("$FLY" apps list --org "$ORG" --json | jq -r '.[].Name // .[].name')"
for app in "$APP_DB" "$APP_SPARKY_API" "$APP_SPARKY_WEB" "$APP_GAUNTLET"; do
  if grep -qx "$app" <<<"$existing"; then
    echo "  exists  $app"
  else
    "$FLY" apps create "$app" --org "$ORG" >/dev/null
    echo "  created $app"
  fi
done

secret_names() { "$FLY" secrets list --app "$1" --json | jq -r '.[].Name // .[].name'; }
has() { grep -qx "$2" <<<"$1"; }
hex() { openssl rand -hex "$1"; }
b64() { openssl rand -base64 "$1" | tr -d '\n'; }

log "Secrets"
db_s="$(secret_names "$APP_DB")"
api_s="$(secret_names "$APP_SPARKY_API")"
g_s="$(secret_names "$APP_GAUNTLET")"

# Database passwords are shared between apps and can't be read back from Fly, so they are
# created together, once, before the database's first start.
if ! has "$db_s" GAUNTLET_DB_PASSWORD; then
  if has "$g_s" DATABASE_URL || has "$api_s" SPARKY_FITNESS_DB_PASSWORD; then
    echo "setup: $APP_GAUNTLET or $APP_SPARKY_API already has database credentials but $APP_DB does not." >&2
    echo "       Refusing to generate new passwords that would not match. See deploy/fly/README.md." >&2
    exit 1
  fi
  pg="$(hex 24)"; gpw="$(hex 24)"; spw="$(hex 24)"; apw="$(hex 24)"
  "$FLY" secrets set --app "$APP_DB" --stage \
    POSTGRES_PASSWORD="$pg" GAUNTLET_DB_PASSWORD="$gpw" SPARKY_DB_PASSWORD="$spw" >/dev/null
  "$FLY" secrets set --app "$APP_SPARKY_API" --stage \
    SPARKY_FITNESS_DB_PASSWORD="$spw" SPARKY_FITNESS_APP_DB_PASSWORD="$apw" >/dev/null
  "$FLY" secrets set --app "$APP_GAUNTLET" --stage \
    DATABASE_URL="postgres://gauntlet:$gpw@$APP_DB.internal:5432/gauntlet" >/dev/null
  unset pg gpw spw apw
  echo "  set database passwords ($APP_DB, $APP_SPARKY_API, $APP_GAUNTLET)"
else
  echo "  database passwords already set"
fi

# Keys that must never change once in use (changing them signs everyone out / breaks stored keys).
if ! has "$api_s" BETTER_AUTH_SECRET; then
  "$FLY" secrets set --app "$APP_SPARKY_API" --stage \
    BETTER_AUTH_SECRET="$(b64 32)" SPARKY_FITNESS_API_ENCRYPTION_KEY="$(hex 32)" >/dev/null
  echo "  set SparkyFitness auth and encryption keys"
fi
if ! has "$g_s" JWT_SECRET; then
  "$FLY" secrets set --app "$APP_GAUNTLET" --stage \
    JWT_SECRET="$(b64 48)" ENCRYPTION_KEY="$(b64 32)" >/dev/null
  echo "  set Gauntlet JWT and encryption keys"
fi

log "Custom domains"
dns_note=()
add_cert() { # app url
  local host="${2#https://}"; host="${host%%/*}"
  case "$host" in *.fly.dev) echo "  $host is a fly.dev address, nothing to do"; return ;; esac
  if "$FLY" certs show "$host" --app "$1" >/dev/null 2>&1; then
    echo "  $host already registered on $1"
  else
    "$FLY" certs add "$host" --app "$1" >/dev/null
    echo "  registered $host on $1"
  fi
  dns_note+=("$host  CNAME  $1.fly.dev   (Cloudflare: DNS only / grey cloud until 'fly certs show' says Issued)")
}
add_cert "$APP_GAUNTLET" "$GAUNTLET_PUBLIC_URL"
add_cert "$APP_SPARKY_WEB" "$SPARKY_PUBLIC_URL"
if [ ${#dns_note[@]} -gt 0 ]; then
  echo
  echo "Add these DNS records in Cloudflare:"
  printf '  %s\n' "${dns_note[@]}"
fi
echo
echo "Setup done. Next: deploy (deploy/fly/deploy.sh, or the Fly setup / Release workflows)."
