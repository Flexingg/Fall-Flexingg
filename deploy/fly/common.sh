# Shared settings for setup.sh and deploy.sh. Source it; don't run it.
#   FLY_APP_PREFIX       e.g. "gauntlet" -> apps gauntlet, gauntlet-db, gauntlet-sparky-api, gauntlet-sparky
#   GAUNTLET_PUBLIC_URL  e.g. https://gauntlet.randalls.cc (defaults to https://<prefix>.fly.dev)
#   SPARKY_PUBLIC_URL    e.g. https://sparky.randalls.cc  (defaults to https://<prefix>-sparky.fly.dev)
set -euo pipefail
: "${FLY_APP_PREFIX:?set FLY_APP_PREFIX (repository variable)}"
case "$FLY_APP_PREFIX" in
  *[!a-z0-9-]* | -* | *-) echo "FLY_APP_PREFIX may only use lowercase letters, digits and dashes" >&2; exit 1 ;;
esac
P="$FLY_APP_PREFIX"
APP_GAUNTLET="$P"
APP_DB="$P-db"
APP_SPARKY_API="$P-sparky-api"
APP_SPARKY_WEB="$P-sparky"
REGION="${FLY_REGION:-iad}"
GAUNTLET_PUBLIC_URL="${GAUNTLET_PUBLIC_URL:-https://$APP_GAUNTLET.fly.dev}"
SPARKY_PUBLIC_URL="${SPARKY_PUBLIC_URL:-https://$APP_SPARKY_WEB.fly.dev}"
GAUNTLET_PUBLIC_URL="${GAUNTLET_PUBLIC_URL%/}"
SPARKY_PUBLIC_URL="${SPARKY_PUBLIC_URL%/}"
for u in "$GAUNTLET_PUBLIC_URL" "$SPARKY_PUBLIC_URL"; do
  case "$u" in https://*) ;; *) echo "Public URLs must start with https:// (got $u)" >&2; exit 1 ;; esac
done
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FLY="${FLYCTL:-flyctl}"
log() { printf '\n==> %s\n' "$*"; }
