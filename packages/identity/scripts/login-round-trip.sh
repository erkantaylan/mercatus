#!/bin/bash
# THE GATE for task 08: a real OIDC login round trip, driven with no browser and no Playwright.
#
# Logto has no password grant, and its PAT token-exchange grant is refused for the application
# types this repo registers ("requested grant type is not allowed for this client"). So the only
# way to a real user token is the authorization-code flow -- which is an interactive sign-in page.
# This script is that page, driven through Logto's own Experience API with a cookie jar.
#
#   store /auth/login  ->  Logto authorize  ->  Logto Experience API (password sign-in)
#   ->  consent  ->  store /auth/callback  ->  the store's OWN session cookie
#
# usage: login-round-trip.sh <store-base> <logto-base> <username> <password> [slug] [staff|shopper]
#   e.g. packages/identity/scripts/login-round-trip.sh \
#          http://127.0.0.1:4002 http://127.0.0.1:3011 acme_owner Mercatus-dev-1 acme staff
set -euo pipefail
STORE=$1; LOGTO=$2; USER=$3; PASS=$4; SLUG=${5:-acme}; AUD=${6:-staff}
JAR=$(mktemp); SJAR=$(mktemp)
trap 'rm -f "$JAR" "$SJAR"' EXIT

loc() { grep -i '^location' | tr -d '\r' | sed 's/^[Ll]ocation: //'; }

echo "== 1. store /auth/login"
AUTHZ=$(curl -s -D - -o /dev/null "$STORE/auth/login?audience=$AUD&slug=$SLUG&next=/" | loc)
case "$AUTHZ" in
  "$LOGTO"/oidc/auth*) echo "   -> $LOGTO/oidc/auth (ok)";;
  *) echo "   FAIL: expected a redirect to the issuer, got: $AUTHZ"; exit 1;;
esac

echo "== 2. follow it to the issuer"
curl -s -c "$JAR" -o /dev/null "$AUTHZ"

echo "== 3. sign in through the Experience API as $USER"
curl -s -b "$JAR" -c "$JAR" -X PUT "$LOGTO/api/experience" \
  -H 'content-type: application/json' -d '{"interactionEvent":"SignIn"}' > /dev/null
VID=$(curl -s -b "$JAR" -c "$JAR" -X POST "$LOGTO/api/experience/verification/password" \
  -H 'content-type: application/json' \
  -d "{\"identifier\":{\"type\":\"username\",\"value\":\"$USER\"},\"password\":\"$PASS\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["verificationId"])')
curl -s -b "$JAR" -c "$JAR" -X POST "$LOGTO/api/experience/identification" \
  -H 'content-type: application/json' \
  -d "{\"interactionEvent\":\"SignIn\",\"verificationId\":\"$VID\"}" > /dev/null
NEXT=$(curl -s -b "$JAR" -c "$JAR" -X POST "$LOGTO/api/experience/submit" \
  -H 'content-type: application/json' -d '{}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["redirectTo"])')
CB=$(curl -s -b "$JAR" -c "$JAR" -D - -o /dev/null "$NEXT" | loc)
if [[ "$CB" == /consent* ]]; then
  echo "   consent required; granting"
  NEXT=$(curl -s -b "$JAR" -c "$JAR" -X POST "$LOGTO/api/interaction/consent" \
    -H 'content-type: application/json' -d '{}' \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["redirectTo"])')
  CB=$(curl -s -b "$JAR" -c "$JAR" -D - -o /dev/null "$NEXT" | loc)
fi
echo "   -> $CB"

echo "== 4. store /auth/callback exchanges the code and issues ITS OWN cookie"
HDRS=$(curl -s -c "$SJAR" -D - -o /tmp/cbbody.txt "$CB"); :
echo "$HDRS" | grep -iE '^HTTP|^set-cookie: mercatus_session' | sed 's/^/   /' | cut -c1-120
grep -q mercatus_session "$SJAR" || { echo "   FAIL: no session cookie"; exit 1; }

echo "== 5. /auth/session, cookie only"
SESSION=$(curl -s -b "$SJAR" "$STORE/auth/session")
echo "   $SESSION"
echo "$SESSION" | AUD="$AUD" python3 -c '
import sys,json,os
s=json.load(sys.stdin)
aud=os.environ["AUD"]
assert s["kind"]==aud, s
assert s["issuedBy"]=="oidc", s
if aud=="staff":
    assert s["tenantId"], s
    assert "owner" in s["roles"], s
else:
    # CD3/BI2: a shopper is tenant-less, always. A tenant here would be the bug.
    assert s["tenantId"] is None, s
    assert s["roles"]==[], s
print("   "+aud+" / oidc / tenant "+str(s["tenantId"])+" / roles "+",".join(s["roles"]))'

if [ "$AUD" = staff ]; then
  echo "== 6. a staff route, cookie only"
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$SJAR" "$STORE/api/products")
  echo "   GET /api/products -> $CODE"
  [ "$CODE" = 200 ] || { echo "   FAIL"; exit 1; }
else
  echo "== 6. a shopper route, cookie only"
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$SJAR" "$STORE/t/$SLUG/orders")
  echo "   GET /t/$SLUG/orders -> $CODE"
  [ "$CODE" = 200 ] || { echo "   FAIL"; exit 1; }
  echo "== 6b. a STAFF route with a shopper session must be refused (BH1)"
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$SJAR" "$STORE/api/products")
  echo "   GET /api/products -> $CODE"
  [ "$CODE" = 403 ] || { echo "   FAIL: expected 403"; exit 1; }
fi
${SESSION_JAR_OUT:+cp "$SJAR" "$SESSION_JAR_OUT"}
echo "ROUND TRIP OK"
