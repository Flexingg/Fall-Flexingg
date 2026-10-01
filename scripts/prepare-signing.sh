#!/usr/bin/env bash
# Turns the four signing secrets into a keystore file plus clean env vars, and checks that the key
# opens, so a bad secret fails in seconds instead of after a long Gradle build.
#
# Secrets pasted into GitHub often carry stray spaces, tabs or newlines (for example copied from an
# indented terminal listing), so every value is trimmed first.
#
# Input env:  RAW_KEYSTORE_B64 RAW_STORE_PW RAW_KEY_ALIAS RAW_KEY_PW  TARGET (keystore file to write)
# Output:     writes $TARGET; appends GAUNTLET_KEYSTORE_PATH / _PASSWORD / GAUNTLET_KEY_ALIAS / _PASSWORD
#             to $GITHUB_ENV when set (masking the secrets in logs).
set -euo pipefail

trim() { printf '%s' "$1" | tr -d '\r\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }
fail() { echo "::error::$*"; exit 1; }

: "${TARGET:?TARGET is required}"
STORE_PW="$(trim "${RAW_STORE_PW:-}")"
KEY_ALIAS="$(trim "${RAW_KEY_ALIAS:-}")"
KEY_PW="$(trim "${RAW_KEY_PW:-}")"
[ -n "$STORE_PW" ] && [ -n "$KEY_ALIAS" ] && [ -n "$KEY_PW" ] || fail "A signing secret is empty after trimming whitespace."

# The alias is just a label, so it is not masked (masking "gauntlet" would hide that word everywhere in the logs).
for v in "$STORE_PW" "$KEY_PW"; do echo "::add-mask::$v"; done

# Whitespace and line breaks inside the base64 are harmless; strip them all.
printf '%s' "${RAW_KEYSTORE_B64:-}" | tr -d '[:space:]' | base64 -d > "$TARGET" 2>/dev/null \
  || fail "ANDROID_KEYSTORE_BASE64 is not valid base64. Paste the whole contents of gauntlet-release.jks.b64."
[ -s "$TARGET" ] || fail "ANDROID_KEYSTORE_BASE64 decoded to an empty file."

if ! listing="$(keytool -list -keystore "$TARGET" -storepass "$STORE_PW" 2>&1)"; then
  fail "Could not open the keystore: the store password (ANDROID_KEYSTORE_PASSWORD) is wrong, or the file is not a keystore."
fi
aliases="$(printf '%s\n' "$listing" | sed -n 's/^\([^,]*\), .*\(PrivateKeyEntry\|trustedCertEntry\).*/\1/p' | paste -sd, -)"
if ! keytool -list -keystore "$TARGET" -storepass "$STORE_PW" -alias "$KEY_ALIAS" >/dev/null 2>&1; then
  fail "ANDROID_KEY_ALIAS '$KEY_ALIAS' is not in the keystore. Aliases found: ${aliases:-none}. (scripts/make-keystore.sh uses 'gauntlet'.)"
fi
# The key password is checked by exporting the key with it.
if ! keytool -importkeystore -srckeystore "$TARGET" -srcstorepass "$STORE_PW" -srcalias "$KEY_ALIAS" -srckeypass "$KEY_PW" \
     -destkeystore "$(mktemp -u).p12" -deststoretype PKCS12 -deststorepass "$STORE_PW" -destkeypass "$KEY_PW" >/dev/null 2>&1; then
  fail "ANDROID_KEY_PASSWORD does not unlock the key '$KEY_ALIAS'."
fi
echo "Signing key OK: alias '$KEY_ALIAS' (keystore has: $aliases)"

if [ -n "${GITHUB_ENV:-}" ]; then
  {
    echo "GAUNTLET_KEYSTORE_PATH=$TARGET"
    echo "GAUNTLET_KEYSTORE_PASSWORD=$STORE_PW"
    echo "GAUNTLET_KEY_ALIAS=$KEY_ALIAS"
    echo "GAUNTLET_KEY_PASSWORD=$KEY_PW"
  } >> "$GITHUB_ENV"
fi
