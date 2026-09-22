# 08 — real identity: Logto behind the adapter, and the store's own session

Status: **done**, both halves of the gate pass. The stub still works and is still the default.

## What exists now

### `packages/core` — the adapter and the session

- **`src/auth/oidc-adapter.ts`** — `LogtoAuthAdapter implements AuthAdapter`, `name: 'oidc'`.
  - `verify()` makes **no network call at all**. It verifies against a JWKS cached on disk and
    maps a Logto organization token (`aud = urn:logto:organization:<orgId>`) to a `StaffPrincipal`,
    resolving the organization to a tenant through the cached org → slug directory and the store's
    own tenant lookup. Unknown subject ⇒ roles `['staff']`, never `['owner']`.
  - `authorizeUrl()` / `exchange()` / `tokenForTenant()` / `issuerReachable()` complete the
    interface. `exchange()` is the only one that needs the issuer.
  - ONE cache file (`OIDC_JWKS_CACHE_PATH`) holds `{client, discovery, jwks, organizations}`.
    Written atomically (temp + rename). It is also where the instance's **client registration**
    comes from, so a store is not handed a client id and secret by hand (CE7).
- **`src/auth/session.ts`** — `SessionIssuer`: HS256 cookie `mercatus_session`, `HttpOnly`,
  `SameSite=Lax`, 12 h. Claim shape is identical to the stub's, so `toPrincipal` is still the one
  place claims become a `Principal`. Cookie parse/serialise is 20 lines; no `@fastify/cookie`.
- **`src/auth/plugin.ts`** — the `onRequest` hook now falls back to the session cookie when there
  is no bearer token. A bearer always wins, so a stale cookie cannot override a credential.
- **`src/auth/factory.ts`** — `AUTH_ADAPTER=oidc` now returns the real adapter instead of throwing.
- **`src/config.ts`** — `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`,
  `OIDC_JWKS_CACHE_PATH`, `SESSION_SECRET`, `SESSION_TTL_SECONDS`, `STORE_PUBLIC_URL`.
  `SESSION_SECRET` falls back to `AUTH_STUB_SECRET`, so nothing that worked before needs changing.

### `apps/store` — `/auth/*`

`GET /auth/login` → 302 to the issuer · `GET /auth/callback` → exchange, then **set the store's own
cookie** and 302 to `next` · `GET /auth/session` → who you are · `POST /auth/logout`.
The four routes work identically on both adapters. `state` is a 10-minute JWT signed with the
session key, so there is no server-side login store.

### `packages/identity` — new workspace package

- `src/logto.ts` — Management API client, plus `readManagementSecret()` which reads the seeded
  `m-default` M2M secret out of Logto's own database (the only way in without a browser).
- `src/bootstrap.ts` — idempotent provisioning: 2 organization scopes, 2 roles (`owner`, `staff`),
  5 applications with their redirect URIs, one **organization per tenant named with the slug**,
  one staff user per tenant with membership + `owner`, and one **shopper with no organization**
  (CD3). Then it writes the data plane's identity cache and `.identity/bootstrap.json`.
- `scripts/login-round-trip.sh` — the gate. A real authorization-code login driven through Logto's
  Experience API with curl; no browser, no Playwright.

### `aspire/AppHostA/apphost.cs`

New resources: `pg-logto` + `db-logto`, the `logto` container (`svhd/logto:1.43.0`, host ports
**3011/3012** because 3001/3002 are the storefronts), and `logto-bootstrap`.
`store-pooled` now also gets `OIDC_ISSUER`, `OIDC_JWKS_CACHE_PATH`, `SESSION_SECRET`,
`STORE_PUBLIC_URL`, and its `AUTH_ADAPTER` comes from **`MERCATUS_AUTH_ADAPTER`**, default `stub`.

## The gate, and what it proved

Run on the real AppHost A topology (`aspire run --detach`), both ways.

**`MERCATUS_AUTH_ADAPTER=oidc`:**

| | |
|---|---|
| staff round trip | `/auth/login` → Logto → consent → `/auth/callback` → session cookie → `/auth/session` = `{kind:"staff", issuedBy:"oidc", tenantId:"3f6b0b8a-…", roles:["owner"]}`; `GET /api/products` 200 with the cookie alone |
| shopper round trip | `{kind:"shopper", tenantId:null, roles:[]}`; `GET /t/acme/orders` 200, `GET /api/products` **403** (BH1) |
| **control plane down** | `docker stop logto`, issuer unreachable — the staff session still answers `/auth/session` and `/api/products` 200, and `/t/acme/products` 200 through Traefik |
| **offline JWKS** | a real Logto organization token presented as a bearer with the issuer stopped: verified from the cached key set, tenant and roles resolved, 200. One byte changed in the signature: 401 |

**default (stub):** `/dev/login/staff` and `/dev/login/shopper` still 200, a stub bearer still
reaches `/api/products`, the new `/auth/*` routes work on the stub too
(`issuedBy:"stub"`), and `/t/acme/products` through Traefik still 200.

**Repo check:** `pnpm turbo run typecheck lint test` → **31/31 tasks, 198 tests, exit 0**
(8 new tests in `packages/core/src/core.test.ts` for the session issuer and the oidc adapter).

## What the next agent needs to know

1. **The stub is still the default everywhere.** `apps/dashboard`, `apps/admin` and
   `apps/storefront` all sign in through `/dev/login/*`, which a store on `oidc` does not register.
   Moving a front end onto Logto means giving it the authorization-code flow first; the
   applications are already registered for it (`.identity/bootstrap.json` has their client ids).
2. **`.identity/` is gitignored and per-machine.** It is written by `logto-bootstrap` at the repo
   root and read by the store. Delete it and re-run the bootstrap to rebuild it; delete the Logto
   database and you get new client ids.
3. **`packages/identity` has no `test` script** — an app with the script and no test files fails
   `pnpm -r test` (lesson 03).
4. **Still outstanding from task 04a:** `apps/platform/src/schemas.ts` has not been moved into
   `packages/contracts`. Untouched here.
5. **Still outstanding from 07b/07c:** `packages/contracts/src/common.ts` still imports
   `DEFAULT_PAGE_LIMIT` / `MAX_PAGE_LIMIT` from `@mercatus/core`, so contracts still cannot be
   imported in a browser. One line in `packages/core` fixes it.
6. The platform and fake-bank were not touched. The platform still mints operator tokens with the
   stub; moving the console onto Logto is a separate piece of work.

## Machine state

Left as found. `aspire stop` run; `docker ps` shows only `mercatus-dash-gate-pg` (task 07b's, on
55432) and `chess-trainer` (pre-existing). Every container this task created —
`mercatus-logto`, `mercatus-logto-pg`, `mercatus-identity-gate-pg`, `mercatus-check-pg` — was
removed, along with the `mercatus-logto-net` network. `svhd/logto:1.43.0` and `:latest` are left in
the image cache on purpose: the pull is minutes and the tags share a digest.
