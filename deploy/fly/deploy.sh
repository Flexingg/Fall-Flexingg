#!/usr/bin/env bash
# Deploy (or update) all four Fly apps in dependency order. Safe to re-run: pinned images that
# haven't changed just restart. Run setup.sh once before the first deploy.
#
#   FLY_APP_PREFIX=gauntlet deploy/fly/deploy.sh [--only gauntlet]
source "$(dirname "$0")/common.sh"
only=""
if [ "${1:-}" = "--only" ]; then only="${2:?--only needs db, sparky-garmin, sparky-api, sparky-web or gauntlet}"; fi
want() { [ -z "$only" ] || [ "$only" = "$1" ]; }
common=(--remote-only --ha=false --primary-region "$REGION" --yes)

if want db; then
  log "Postgres ($APP_DB)"
  "$FLY" deploy "$ROOT/deploy/postgres" --config "$ROOT/deploy/fly/db.toml" --app "$APP_DB" \
    --dockerfile "$ROOT/deploy/postgres/Dockerfile" "${common[@]}"
fi

if want sparky-garmin; then
  log "Garmin Connect service ($APP_SPARKY_GARMIN)"
  "$FLY" deploy "$ROOT/deploy/garmin" --config "$ROOT/deploy/fly/sparky-garmin.toml" --app "$APP_SPARKY_GARMIN" \
    --dockerfile "$ROOT/deploy/garmin/Dockerfile" "${common[@]}"
fi

if want sparky-api; then
  log "SparkyFitness server ($APP_SPARKY_API)"
  "$FLY" deploy --config "$ROOT/deploy/fly/sparky-api.toml" --app "$APP_SPARKY_API" "${common[@]}" \
    -e SPARKY_FITNESS_DB_HOST="$APP_DB.internal" \
    -e GARMIN_MICROSERVICE_URL="http://$APP_SPARKY_GARMIN.internal:8000" \
    -e SPARKY_FITNESS_FRONTEND_URL="$SPARKY_PUBLIC_URL" \
    -e SPARKY_FITNESS_ADMIN_EMAIL="${SPARKY_ADMIN_EMAIL:-}"
fi

if want sparky-web; then
  log "SparkyFitness site ($APP_SPARKY_WEB)"
  "$FLY" deploy --config "$ROOT/deploy/fly/sparky-web.toml" --app "$APP_SPARKY_WEB" "${common[@]}" \
    -e SPARKY_FITNESS_SERVER_HOST="$APP_SPARKY_API.internal" \
    -e SPARKY_FITNESS_FRONTEND_URL="$SPARKY_PUBLIC_URL"
fi

if want gauntlet; then
  log "Gauntlet ($APP_GAUNTLET)"
  # Release APK (if the workflow put one in deploy/fly/downloads) ships inside the image.
  "$FLY" deploy "$ROOT" --config "$ROOT/deploy/fly/gauntlet.toml" --app "$APP_GAUNTLET" \
    --dockerfile "$ROOT/Dockerfile" "${common[@]}" \
    -e SPARKY_URL="http://$APP_SPARKY_API.internal:3010" \
    -e SPARKY_PUBLIC_URL="$SPARKY_PUBLIC_URL" \
    -e PUBLIC_WEB_URL="$GAUNTLET_PUBLIC_URL" \
    -e ASSETLINKS_SHA256="${ASSETLINKS_SHA256:-}"
fi

log "Checking the deployment"
ok=true
check() { # name url [jq filter expected]
  local body; body="$(curl -fsS --max-time 30 --retry 5 --retry-delay 3 --retry-all-errors "$2")" \
    || { echo "  FAIL $1: $2"; ok=false; return; }
  if [ -n "${3:-}" ] && [ "$(jq -r "$3" <<<"$body")" != "$4" ]; then
    echo "  FAIL $1: $3 = $(jq -r "$3" <<<"$body"), expected $4"; ok=false; return
  fi
  echo "  ok   $1"
}
check "Gauntlet health" "https://$APP_GAUNTLET.fly.dev/api/health"
check "SparkyFitness health" "https://$APP_SPARKY_WEB.fly.dev/api/health"
check "SparkyFitness trusts $SPARKY_PUBLIC_URL" "https://$APP_SPARKY_WEB.fly.dev/api/auth/settings" \
  '.trusted_origin' "$SPARKY_PUBLIC_URL"
# The SparkyFitness server must reach the Garmin service over Fly's private network (best effort:
# needs `fly ssh`, so a failure here is a warning rather than a failed deploy).
if "$FLY" ssh console --app "$APP_SPARKY_API" \
     -C "wget -qO- -T 10 http://$APP_SPARKY_GARMIN.internal:8000/openapi.json" 2>/dev/null | grep -q '"openapi"'; then
  echo "  ok   SparkyFitness server reaches the Garmin service"
else
  echo "  WARN could not confirm the SparkyFitness server reaches $APP_SPARKY_GARMIN.internal:8000;" \
       "check: fly logs -a $APP_SPARKY_GARMIN"
fi
if [ -n "${EXPECT_APK_VERSION:-}" ]; then
  check "APK $EXPECT_APK_VERSION offered" "https://$APP_GAUNTLET.fly.dev/api/app/android" \
    '.version' "$EXPECT_APK_VERSION"
fi
$ok || { echo "Deployment checks failed." >&2; exit 1; }
echo "Deployed. Gauntlet: $GAUNTLET_PUBLIC_URL  SparkyFitness: $SPARKY_PUBLIC_URL"
