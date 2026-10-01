#!/bin/sh
# Adds one rule to the SparkyFitness site's nginx template: when an app's sign-in page (Strava,
# Fitbit, Oura, Polar, COROS) sends the person back to <sparkyfitness>/<app>/callback, hand them on to
# Gauntlet's own page, which finishes connecting from inside the app. SparkyFitness decides that
# return address, so the redirect has to live on its host.
set -eu
TEMPLATE=/etc/nginx/templates/default.conf.template
GAUNTLET_URL="${1%/}"
[ -n "$GAUNTLET_URL" ] || { echo "redirect.sh: no Gauntlet address given; leaving nginx as shipped"; exit 0; }
grep -q '^  location / {' "$TEMPLATE" || { echo "redirect.sh: unexpected nginx template" >&2; exit 1; }

SNIPPET="  # Gauntlet: finish connecting an app from inside the Gauntlet app.
  location ~ ^/(coros|fitbit|oura|polar|strava)/callback\$ {
    return 302 ${GAUNTLET_URL}/oauth/\$1\$is_args\$args;
  }"
awk -v snip="$SNIPPET" '/^  location \/ \{/ && !done { print snip; print ""; done = 1 } { print }' "$TEMPLATE" > /tmp/template.new
mv /tmp/template.new "$TEMPLATE"
grep -q '/oauth/' "$TEMPLATE" || { echo "redirect.sh: rule was not added" >&2; exit 1; }
echo "redirect.sh: /<app>/callback now hands over to ${GAUNTLET_URL}/oauth/<app>"
