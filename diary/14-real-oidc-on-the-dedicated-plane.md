# 14 — phase 0: the dedicated instance on real OIDC

**Goal (docs/PLAN-opt-in-registration.md, phase 0):** run both AppHosts with `AUTH_ADAPTER=oidc`
and fix what breaks, *before* anything about registration changes — while the dedicated store's
address is still a constant, so only one thing is moving.

**Result:** done. Two lines of AppHost A were wrong; nothing in the application code was.

## What was broken

Two defects, both in `aspire/AppHostA/apphost.cs`, both invisible under the default `stub`:

1. **The dedicated identity cache was never written.** `task-identity-bootstrap` writes a second
   cache file only when `IDENTITY_CACHE_PATH_DEDICATED` is set, and AppHost A never set it.
   AppHost B's store reads `.identity/store-zenith.json` (`OIDC_JWKS_CACHE_PATH`) in the adapter's
   **constructor**, found nothing, and came up with `clientId = ''`. First `/auth/login`:
   `400 This instance is not registered with the issuer`.
2. **The registered redirect URI did not match the one the store sends.** A registered
   `http://127.0.0.1:28403/auth/callback`. B builds its `redirect_uri` from `STORE_PUBLIC_URL`,
   which is an Aspire `EndpointReference`, and Aspire renders endpoint hosts as `localhost` — so B
   asked for `http://localhost:28403/auth/callback`. Logto compares redirect URIs as strings:
   `400 oidc.invalid_redirect_uri`, at the issuer, before the sign-in page ever rendered.

Confirmed the second one by `PATCH`ing the application's `redirectUris` live through the
Management API and watching the whole round trip complete, rather than guessing and paying an
`aspire stop`/`run` cycle per guess.

## The change

`aspire/AppHostA/apphost.cs`, 19 lines, 15 of them comment:

- `IDENTITY_CACHE_PATH_DEDICATED` → `../../.identity/store-zenith.json` on `task-identity-bootstrap`.
- `storeDedicatedBase` now spells its host `localhost`, matching what B actually asks for and what
  `.stack/apphost-b.json` publishes to the e2e suite. The comment says why the spelling is
  load-bearing and that phase 1 deletes the guess entirely.

Plus a new gate script, `packages/identity/scripts/shopper-sso-across-planes.sh` — one issuer
cookie jar, two stores, asserts the same subject on both and that neither store's session cookie
works at the other.

`AUTH_ADAPTER` still defaults to `stub` in both AppHosts. Phase 0 was not asked to flip the
default and flipping it would break the three browser UIs (see below).

## The gate, observed

Clean stack, both AppHosts restarted from zero containers, `MERCATUS_AUTH_ADAPTER=oidc` on both,
no live patching. Pooled store `http://localhost:16371`, dedicated `http://localhost:28403`,
issuer `http://127.0.0.1:28311`.

**1. Dedicated store, staff, `login-round-trip.sh`:**

```
== 1. store /auth/login       -> http://127.0.0.1:28311/oidc/auth (ok)
== 3. sign in as zenith_owner    consent required; granting
     -> http://localhost:28403/auth/callback?code=Eqt5BU14T7Ae…&iss=http%3A%2F%2F127.0.0.1%3A28311%2Foidc
== 4. /auth/callback          HTTP/1.1 302 Found  + set-cookie: mercatus_session=…
== 5. /auth/session  {"kind":"staff","subject":"ejdrsuosx2cz",
                      "tenantId":"3f6b0b8a-1f4a-4d2a-9c3e-0a1b2c3d4e03",
                      "roles":["owner"],"issuedBy":"oidc"}
== 6. GET /api/products -> 200
ROUND TRIP OK
```

Dedicated store, shopper: same shape, `tenantId: null`, `roles: []`, `GET /t/zenith/orders -> 200`,
and `GET /api/products -> 403` (BH1).

**2. One shopper across both planes, `shopper-sso-across-planes.sh`:**

```
== 1. POOLED  /auth/login?audience=shopper  -> issuer asks for a password (no session yet)
== 2. sign in ONCE at the issuer
      pooled /auth/session:    {"kind":"shopper","subject":"esiql1bctmog","tenantId":null,…,"issuedBy":"oidc"}
== 3. DEDICATED /auth/login?audience=shopper -- SAME issuer jar, NO password
      -> http://localhost:28403/auth/callback   (no sign-in page: the issuer recognised the session)
      dedicated /auth/session: {"kind":"shopper","subject":"esiql1bctmog","tenantId":null,…,"issuedBy":"oidc"}
== 4. same subject on both planes: esiql1bctmog
== 5. pooled cookie at the dedicated store -> 401
SSO ACROSS PLANES OK
```

Step 5 is the half worth keeping: the two planes agree on **who**, and share nothing else. Each
store signs its own session (Q20), which is what keeps the dedicated one selling while we are down.

**3. A real browser (Chrome, driven through the extension):**

| step | observed |
|---|---|
| `localhost:16371/auth/login?audience=shopper&next=/auth/session` | Logto sign-in page at `127.0.0.1:28311/sign-in?app_id=deu8sounyq4ygx3qkgquq` |
| typed `shopper` / dev password, Sign in | back at `localhost:16371/auth/session` → `{"kind":"shopper","subject":"esiql1bctmog",…,"issuedBy":"oidc"}` |
| `localhost:28403/auth/login?audience=shopper&next=/auth/session` | **no sign-in page at all** → `localhost:28403/auth/session` → same subject `esiql1bctmog` |
| `127.0.0.1:28311/oidc/session/end` | "You have successfully signed out." |
| `localhost:28403/auth/login?audience=staff&slug=zenith` | sign-in page at `app_id=rohvq5pi4lv58wp4yz8ll` (= the dedicated client in `.identity/store-zenith.json`) |
| typed `zenith_owner` / dev password | `localhost:28403/auth/session` → `{"kind":"staff","subject":"ejdrsuosx2cz","tenantId":"3f6b0b8a-…-4e03","roles":["owner"],"issuedBy":"oidc"}` |

## Regression check

Both AppHosts restarted on the **default** (`stub`), from zero containers:

- `pnpm test:e2e` → **16 passed (40.2 s)**, including the dedicated-outage spec that stops the
  control plane and relaunches it.
- `pnpm -r test` → see below; unchanged from task 13's 244.
- `git diff v1.0.0 --stat`: `aspire/AppHostA/apphost.cs` only (plus the plan doc and the new script).

## Known-and-left, for phase 1

- **The three browser UIs have no OIDC path.** `apps/storefront/lib/session.ts` and
  `apps/dashboard/src/auth/adapter.ts` sign in through the store's `/dev/login/*`, which does not
  exist under `oidc`. So `MERCATUS_AUTH_ADAPTER=oidc` puts the **store API** on real OIDC on both
  planes and leaves the storefront, the dashboard and the admin console unable to sign anybody in.
  That is the state task 08 left deliberately, and it is why the default is still `stub`. Moving
  them over is its own piece of work, not phase 0's.
- **`STOREFRONT_DEDICATED_URL` and `DASHBOARD_DEDICATED_URL` are unset**, so the bootstrap registers
  the dedicated storefront/dashboard at the defaults `127.0.0.1:3002` and `127.0.0.1:5175` — ports
  AppHost B stopped using when they became Aspire-assigned. A **cannot** know them from its own
  application model. This is exactly the disease phase 1 cures, and it is the second reason the
  redirect-URI list has to come from the instance rather than from A.
- Once phase 1 lands, `storeDedicatedBase`, `STORE_DEDICATED_URL` and the `store-dedicated`
  entry in `packages/identity/src/bootstrap.ts` all go away together (plan step 8).

## State left behind

Both AppHosts stopped, containers back to zero. `.identity/`, `.instance/`, `.stack/` hold the
artefacts of the last (stub) run; all three are regenerated per run and none is tracked.
