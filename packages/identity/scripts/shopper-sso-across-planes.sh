#!/bin/bash
# THE SECOND HALF OF PHASE 0's GATE: one shopper, one browser session at the issuer, two stores on
# two different planes -- and the dedicated one recognises them without asking for the password
# again.
#
# This is the claim README makes ("centralised identity across both planes") reduced to something
# that either exits 0 or does not. It is deliberately ONE cookie jar for the issuer ($IJAR): that
# jar IS the browser. The two stores get a jar each, because the whole point of Q20 is that each
# store issues its OWN session cookie and neither can read the other's.
#
#   pooled   /auth/login -> issuer -> password -> consent -> /auth/callback -> pooled cookie
#   dedicated/auth/login -> issuer -> NO PASSWORD, same jar  -> /auth/callback -> dedicated cookie
#   both /auth/session must name the SAME subject
#
# usage: shopper-sso-across-planes.sh <pooled-base> <dedicated-base> <logto-base> [user] [pass] [slug]
set -euo pipefail
POOLED=$1; DEDICATED=$2; LOGTO=$3
USER=${4:-shopper}; PASS=${5:-Mercatus-dev-1}; SLUG=${6:-acme}

IJAR=$(mktemp); PJAR=$(mktemp); DJAR=$(mktemp)
trap 'rm -f "$IJAR" "$PJAR" "$DJAR"' EXIT

loc() { grep -i '^location' | tr -d '\r' | sed 's/^[Ll]ocation: //'; }
jget() { python3 -c "import sys,json;print(json.load(sys.stdin)[\"$1\"])"; }

# Follows the issuer's authorize URL with the shared jar and returns the store callback URL.
# If it lands on /consent it grants it; if it lands on /sign-in the caller has no session yet.
settle() {
  local url=$1 next
  next=$(curl -s -b "$IJAR" -c "$IJAR" -D - -o /dev/null "$url" | loc)
  while [[ "$next" == /* ]]; do
    case "$next" in
      /consent*)
        next=$(curl -s -b "$IJAR" -c "$IJAR" -X POST "$LOGTO/api/interaction/consent" \
          -H 'content-type: application/json' -d '{}' | jget redirectTo)
        ;;
      /sign-in*|/register*) echo "SIGN_IN_REQUIRED"; return 0 ;;
      *) next="$LOGTO$next" ;;
    esac
    next=$(curl -s -b "$IJAR" -c "$IJAR" -D - -o /dev/null "$next" | loc)
  done
  echo "$next"
}

echo "== 1. POOLED $POOLED: /auth/login?audience=shopper"
AUTHZ=$(curl -s -D - -o /dev/null "$POOLED/auth/login?audience=shopper&next=/" | loc)
echo "   302 -> ${AUTHZ%%\?*}"
CB=$(settle "$AUTHZ")
[ "$CB" = SIGN_IN_REQUIRED ] || { echo "   FAIL: expected the issuer to ask for a password first"; exit 1; }
echo "   issuer asks for a password (no session yet)"

echo "== 2. sign in once, at the issuer, through the Experience API as $USER"
curl -s -b "$IJAR" -c "$IJAR" -X PUT "$LOGTO/api/experience" \
  -H 'content-type: application/json' -d '{"interactionEvent":"SignIn"}' > /dev/null
VID=$(curl -s -b "$IJAR" -c "$IJAR" -X POST "$LOGTO/api/experience/verification/password" \
  -H 'content-type: application/json' \
  -d "{\"identifier\":{\"type\":\"username\",\"value\":\"$USER\"},\"password\":\"$PASS\"}" | jget verificationId)
curl -s -b "$IJAR" -c "$IJAR" -X POST "$LOGTO/api/experience/identification" \
  -H 'content-type: application/json' \
  -d "{\"interactionEvent\":\"SignIn\",\"verificationId\":\"$VID\"}" > /dev/null
NEXT=$(curl -s -b "$IJAR" -c "$IJAR" -X POST "$LOGTO/api/experience/submit" \
  -H 'content-type: application/json' -d '{}' | jget redirectTo)
CB=$(settle "$NEXT")
echo "   -> ${CB%%\?*}"
curl -s -c "$PJAR" -o /dev/null "$CB"
POOLED_SESSION=$(curl -s -b "$PJAR" "$POOLED/auth/session")
echo "   pooled /auth/session: $POOLED_SESSION"

echo "== 3. DEDICATED $DEDICATED: /auth/login?audience=shopper -- SAME issuer jar, NO password"
AUTHZ=$(curl -s -D - -o /dev/null "$DEDICATED/auth/login?audience=shopper&next=/" | loc)
echo "   302 -> ${AUTHZ%%\?*}"
CB=$(settle "$AUTHZ")
[ "$CB" = SIGN_IN_REQUIRED ] && { echo "   FAIL: the dedicated store did NOT recognise the shopper"; exit 1; }
echo "   -> ${CB%%\?*}   (no sign-in page: the issuer recognised the session)"
curl -s -c "$DJAR" -o /dev/null "$CB"
DEDICATED_SESSION=$(curl -s -b "$DJAR" "$DEDICATED/auth/session")
echo "   dedicated /auth/session: $DEDICATED_SESSION"

echo "== 4. the two stores must name the SAME person, and neither may hold a tenant (CD3, BI2)"
printf '%s\n%s\n' "$POOLED_SESSION" "$DEDICATED_SESSION" | python3 -c '
import sys, json
pooled, dedicated = (json.loads(line) for line in sys.stdin)
assert pooled["kind"] == dedicated["kind"] == "shopper", (pooled, dedicated)
assert pooled["issuedBy"] == dedicated["issuedBy"] == "oidc", (pooled, dedicated)
assert pooled["tenantId"] is None and dedicated["tenantId"] is None, (pooled, dedicated)
assert pooled["subject"] == dedicated["subject"], (pooled["subject"], dedicated["subject"])
print("   same subject on both planes: " + pooled["subject"])'

echo "== 5. and the two store sessions are NOT interchangeable (Q20: each store signs its own)"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$PJAR" "$DEDICATED/auth/session")
echo "   pooled cookie at the dedicated store -> $CODE"
[ "$CODE" = 401 ] || { echo "   FAIL: expected 401"; exit 1; }
echo "SSO ACROSS PLANES OK"
