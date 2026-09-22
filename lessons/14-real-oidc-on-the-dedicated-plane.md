# 14 — real OIDC on both planes (phase 0)

## The only two things that were actually broken

1. **`IDENTITY_CACHE_PATH_DEDICATED` was never set by AppHost A.** `packages/identity/src/bootstrap.ts`
   has supported it since task 08 and writes nothing when it is absent, so `.identity/store-zenith.json`
   never existed. AppHost B's store points `OIDC_JWKS_CACHE_PATH` at that file, reads it once at
   construction, gets `{}`, and ends up with `clientId = ''`. Symptom: `/auth/login` answers **400
   "This instance is not registered with the issuer"** — which reads like missing env and is a
   missing FILE.
2. **Host spelling.** A registered `http://127.0.0.1:28403/auth/callback`; B sends
   `http://localhost:28403/auth/callback`, because B builds it from `STORE_PUBLIC_URL`, which is an
   Aspire `EndpointReference`, and **Aspire renders every endpoint host as `localhost`**. Logto
   matches `redirect_uri` as a STRING, so the two are different URIs. Symptom: the authorize
   request answers **400 `oidc.invalid_redirect_uri`** — at the issuer, before any sign-in page, so
   `/api/experience` then answers `session.not_found` and the round-trip script dies on
   `KeyError: 'verificationId'`. **That KeyError is never the Experience API; it is always a failed
   authorize two steps earlier.** Print the body of the authorize GET first.

Everything else in the OIDC path worked untouched: the adapter, the code exchange, the
organization token, the offline JWKS, the store's own session cookie.

## `localhost` vs `127.0.0.1` is load-bearing in three places at once

They are the same socket and different strings, and three consumers must agree:

| | spelling |
|---|---|
| the redirect URI registered in Logto | whatever AppHost A writes |
| the `redirect_uri` the store sends | from `STORE_PUBLIC_URL` → Aspire → `localhost` |
| `.stack/apphost-b.json` → the e2e suite, curl, the browser | Aspire → `localhost` |

Pick `localhost` and the whole chain lines up. Pick `127.0.0.1` for the registration and you get
`invalid_redirect_uri`; mix them in a **cookie jar** and you get a subtler one:
`login-round-trip.sh http://127.0.0.1:28403 …` completes the exchange, sets the cookie on the
`localhost` callback, then asks `127.0.0.1` for `/auth/session` and gets `UNAUTHENTICATED`. Nothing
is wrong; curl simply will not send a `localhost` cookie to `127.0.0.1`. **Drive the store at the
same host spelling it publishes.**

## Logto, beyond lesson 08

- `GET /oidc/session/end` signs the browser out with no `id_token_hint` and lands on
  `/oidc/session/end/success`. That is how you test a second user in one browser profile.
- Consent is per (user, application) and it is remembered. The first round trip for a user at a
  given client goes through `/consent`; later ones do not, so a browser run after a curl run looks
  suspiciously smooth. It is not a bug and it is not SSO — check the sign-in page, not the consent
  page, to tell whether the session was recognised.
- `PATCH /api/applications/:id` with `{"oidcClientMetadata":{"redirectUris":[…]}}` replaces the
  list. Patching it live is the cheapest way to test a redirect-URI hypothesis: an `aspire stop` +
  `aspire run` on A re-seeds Logto and costs a full cycle plus B's instance credential.

## Things that are NOT broken and will look like it

- **`/dev/login/*` disappears under `oidc`, and the storefront, the dashboard and the admin console
  have no other way in** — `apps/storefront/lib/session.ts` and `apps/dashboard/src/auth/adapter.ts`
  only ever call `/dev/login/*`. So `MERCATUS_AUTH_ADAPTER=oidc` puts the **store API** on real OIDC
  and leaves the three browser UIs unable to sign anybody in, on both planes. That is the state
  task 08 left and the reason the default is still `stub`. Phase 0 does not change it.
- **The dedicated storefront/dashboard redirect URIs are registered at stale ports**
  (`STOREFRONT_DEDICATED_URL`/`DASHBOARD_DEDICATED_URL` are unset, so the bootstrap defaults to
  `127.0.0.1:3002` and `127.0.0.1:5175`, which B stopped using when its ports became
  Aspire-assigned). A cannot know them — that is precisely the problem phase 1 exists to solve.

## Running the gate

- Order matters exactly once: A's `task-identity-bootstrap` must have finished before B's store
  process starts, because the adapter reads the cache file **in its constructor** and never again.
  A is ~15 s to six green hostnames, so starting B after that poll loop is enough. There is no
  cross-AppHost `WaitFor`, and there should not be.
- `rm .instance/zenith.json` before re-running B against a rebuilt A (lesson 10, still true).
- Two scripts, both exit non-zero on failure:
  `packages/identity/scripts/login-round-trip.sh <store> <logto> <user> <pass> <slug> <staff|shopper>`
  and `packages/identity/scripts/shopper-sso-across-planes.sh <pooled> <dedicated> <logto>`.
