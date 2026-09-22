#!/usr/bin/env bash
# Every application Logto holds, and the redirect URIs on it.
#
# The one question worth asking when a login answers `oidc.invalid_redirect_uri`: Logto matches a
# redirect_uri as a STRING, so "it is registered" is never the question -- "registered with which
# spelling, on which application" is. Since v2.0.0 a dedicated instance has an application of its
# own per INSTALLATION, while the dashboard and the storefront are one shared client each, so
# "whose URI is this" is a question with a real answer.
#
# Reads the M2M credential AppHost A's identity bootstrap wrote (.identity/management.json, 0600),
# exchanges it for a token and asks the Management API. Nothing here writes.
#
#   packages/identity/scripts/list-applications.sh [path/to/management.json]
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
credential="${1:-$root/.identity/management.json}"

[ -f "$credential" ] || {
  echo "no management credential at $credential -- is AppHost A up, and has task-identity-bootstrap finished?" >&2
  exit 1
}

endpoint=$(jq -r .endpoint "$credential")
admin=$(jq -r .adminEndpoint "$credential")
client_id=$(jq -r .clientId "$credential")
client_secret=$(jq -r .clientSecret "$credential")

token=$(curl -sS -X POST "$admin/oidc/token" \
  -u "$client_id:$client_secret" \
  -d grant_type=client_credentials \
  -d resource=https://default.logto.app/api \
  -d scope=all | jq -r .access_token)

[ "$token" != "null" ] && [ -n "$token" ] || { echo "could not get a management token from $admin" >&2; exit 1; }

body=$(curl -sS "$endpoint/api/applications" -H "authorization: Bearer $token")
if ! echo "$body" | jq -e 'type == "array"' >/dev/null 2>&1; then
  echo "the Management API did not answer with a list of applications:" >&2
  echo "$body" >&2
  exit 1
fi
echo "$body" | jq -r '
  sort_by(.name)[]
  | "\(.name)  [\(.type)]  id=\(.id)",
    ((.oidcClientMetadata.redirectUris // []) | if length == 0 then "    (no redirect URIs)" else .[] | "    " + . end),
    ((.oidcClientMetadata.postLogoutRedirectUris // [])[] | "    post-logout: " + .),
    ""'
