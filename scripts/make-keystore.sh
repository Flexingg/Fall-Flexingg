#!/usr/bin/env bash
# Create the Android release signing key and print what to put in GitHub.
#
#   scripts/make-keystore.sh [output-dir]
#
# Writes gauntlet-release.jks and gauntlet-release.jks.b64 to the output dir (default: current
# dir). BACK THE .jks UP SOMEWHERE SAFE. Phones only accept an update signed by the same key, so
# if you lose it, everyone has to uninstall Gauntlet (losing local app data) to get a new build.
set -euo pipefail

OUT="${1:-.}"
mkdir -p "$OUT"
JKS="$OUT/gauntlet-release.jks"
ALIAS="gauntlet"
[[ -e "$JKS" ]] && { echo "$JKS already exists; refusing to overwrite it." >&2; exit 1; }
command -v keytool >/dev/null || { echo "keytool not found. Install a JDK (e.g. openjdk-21)." >&2; exit 1; }

PASS="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
keytool -genkeypair -v -keystore "$JKS" -alias "$ALIAS" -keyalg RSA -keysize 4096 -validity 36500 \
  -storepass "$PASS" -keypass "$PASS" -dname "CN=Gauntlet, O=Gauntlet" >/dev/null 2>&1
base64 -w0 "$JKS" > "$JKS.b64"
SHA="$(keytool -list -v -keystore "$JKS" -alias "$ALIAS" -storepass "$PASS" 2>/dev/null | sed -n 's/^[[:space:]]*SHA256: //p')"

cat <<MSG

Created $JKS  (keep a backup!)

Add these in GitHub: repo → Settings → Secrets and variables → Actions → New repository secret
(paste only the value; the workflow trims stray spaces, but don't include the name)

  ANDROID_KEYSTORE_BASE64    contents of $JKS.b64
  ANDROID_KEYSTORE_PASSWORD  $PASS
  ANDROID_KEY_ALIAS          $ALIAS
  ANDROID_KEY_PASSWORD       $PASS

Invite links open the app automatically: releases publish this key's fingerprint
($SHA) at /.well-known/assetlinks.json.

MSG
