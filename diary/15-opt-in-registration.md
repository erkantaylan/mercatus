# 15 — opt-in registration (phase 1 of the v2.0.0 plan)

Baseline `1c6f609` (phase 0). All nine items of the plan's phase 1 list are done.

## What changed, by plan item

1. **`baseUrl`, `dashboardUrl`, `storefrontUrl` on the register request.** Contracts first
   (`packages/contracts/src/platform.ts`), then `apps/store/src/provision.ts`, which takes them
   from `STORE_PUBLIC_URL` / `DASHBOARD_PUBLIC_URL` / `STOREFRONT_PUBLIC_URL` — the same
   `EndpointReference`s the store itself uses, so the registered redirect URI and the
   `redirect_uri` the store later sends are the same string by construction (lesson 14).
   `storefrontUrl` is beyond the plan's two and is there to close the `STOREFRONT_DEDICATED_URL`
   gap phase 0 flagged.
2. **`expectedHost` on `POST /installations`**, persisted with the three reported URLs and the
   issuer application id (`packages/db-platform` schema + migration `0002`).
3. **Host pinning.** `hostMismatch()` in the register route, checked on EVERY reported URL,
   **before** the bootstrap token is burned. One generic 401 to the caller, the real reason at
   `warn` in the log (`S1`).
4. **The Management API client at runtime.** It was already a usable client exported from
   `@mercatus/identity`; the work was the credential. `readManagementSecret` moved to its own
   module so importing the client cannot drag a Postgres driver into the control plane (`CD2`),
   `task-identity-bootstrap` now writes `.identity/management.json` 0600
   (`IDENTITY_MANAGEMENT_OUT`), and the platform reads it **lazily** via `LOGTO_MANAGEMENT_PATH`
   — no `WaitForCompletion`, because the control plane must be listening long before Logto has
   seeded. `apps/platform/src/identity.ts` is the new seam.
5. **Read-modify-write redirect URIs**, set-union, idempotent — `packages/identity/src/applications.ts`.
6. **`oidc: {issuer, clientId, clientSecret, organizationId}` in the register response.** The
   instance is configured by the answer. `organizationId` is THIS tenant's only: the old handoff
   file gave a box someone else owns the organization directory of every tenant we have.
7. **`DELETE /installations/:id`**, built in the same commit (`CK1`).
8. **Deleted**: `storeDedicatedBase`, `STORE_DEDICATED_URL`, `MERCATUS_STORE_DEDICATED_PORT`,
   `IDENTITY_CACHE_PATH_DEDICATED`, `DASHBOARD_DEDICATED_URL`, `STOREFRONT_DEDICATED_URL`, the
   `store-dedicated` entry in `bootstrap.ts`, and the `.identity/store-zenith.json` handoff.
   Four fixed ports are now three.
9. AppHost B names no port at all.

## One defect found and fixed mid-gate

Keyed on the tenant slug, a second installation of the same tenant took over the first one's Logto
application — and `DELETE /installations/:id` on the throwaway would have deleted the LIVE store's
client while that box was serving. Observed directly: one application carrying both `:11378` and
`:19999`. Applications are now named per installation.

## The gate, as it ran

AppHost A on `MERCATUS_AUTH_ADAPTER=oidc`, then AppHost B, both `--detach`.

**B on an Aspire-assigned port** — `.stack/apphost-b.json` said `store_dedicated:
http://localhost:18171` (and `11378` on the previous run, and `11438` on the stub run: three runs,
three ports, nothing fixed).

**It registered.** `task-provision-tenant-zenith`:

```
  registering at http://localhost:18171
  registered installation 3f6b0b8a-1f4a-4d2a-9c3e-0a1b2c3d4e20 for zenith
  wrote the identity cache -> /home/kappa/Desktop/projects/mercatus/.identity/store-zenith.json
  mirrored tenant zenith (3f6b0b8a-1f4a-4d2a-9c3e-0a1b2c3d4e03)
  dev catalog: 4 product(s) written
```

**The redirect URI is in Logto**, via the Management API (`GET /api/applications`):

```
  Mercatus store (tenant zenith / 3f6b0b8a-1f4a-4d2a-9c3e-0a1b2c3d4e20) fc3q48ra3ov1d6qrpsy73
        redirect  http://localhost:18171/auth/callback
  Mercatus storefront                    1777obq6v9n0igtqs193w
        redirect  http://localhost:18892/api/auth/callback
        redirect  http://localhost:18172/api/auth/callback
  Mercatus platform console              1bga9pxdrnx8gyrtb06lu
        redirect  http://localhost:18894/callback
  Mercatus dashboard                     v4uo8klkxhie50eb7j5vk
        redirect  http://localhost:18893/callback
        redirect  http://localhost:18173/callback
  Mercatus store (pooled)                nuownowhzka3c5i3oid2b
        redirect  http://localhost:18891/auth/callback
```

No `Mercatus store (dedicated)`, and no `127.0.0.1:3002` / `:5175` left over — the stale-default
registrations phase 0 flagged are gone.

**A real browser login on the dedicated store.** `http://localhost:18171/auth/login?audience=staff
&slug=zenith&next=/auth/session` → a genuine Logto sign-in page at
`127.0.0.1:28311/sign-in?app_id=fc3q48ra3ov1d6qrpsy73` (the application minted at registration, not
a pre-seeded one) → typed `zenith_owner` / `Mercatus-dev-1` → landed on

```
http://localhost:18171/auth/session
{"kind":"staff","subject":"p2150uzm5nmy","tenantId":"3f6b0b8a-1f4a-4d2a-9c3e-0a1b2c3d4e03",
 "roles":["owner"],"expiresAt":1790144357,"issuedBy":"oidc"}
```

`login-round-trip.sh` and `shopper-sso-across-planes.sh` both exit 0 against the same port.

**A mismatched host is rejected.** Token minted with `expectedHost: localhost`:

```
== register from evil.example -- MUST be refused
   HTTP 401  {"error":{"code":"UNAUTHENTICATED","message":"Not authenticated."}}
== honest baseUrl, evil dashboardUrl -- MUST also be refused
   HTTP 401  {"error":{"code":"UNAUTHENTICATED","message":"Not authenticated."}}
== the token was NOT burned: an honest registration still succeeds
   HTTP 200  {... "oidc": {"clientId": "792p032o6rhr8skdbcksd", ...}}
```

and in the platform log (`S1` — generic out, specific in):

```
"reason":"reported host evil.example does not match expectedHost localhost (https://evil.example)",
"msg":"registration refused: host pinning"
```

**Deprovisioning** that throwaway installation: `DELETE` → 204, again → 404, its client
`792p032o6rhr8skdbcksd` gone from Logto, the live `fc3q48ra3ov1d6qrpsy73` untouched, and
`login-round-trip.sh` still `ROUND TRIP OK` afterwards.

## Regression check against v1.0.0

Both AppHosts restarted on the **default** (`stub`) adapter, dedicated store on `11438`:
`pnpm test:e2e` → **16 passed (45.2s)**, including the control-plane-outage spec. Unit suites:
platform 25, store 45, db-store 98, core 26, contracts 25, db-platform 11, fake-bank 17 — all
green. `pnpm -r typecheck` and `pnpm -r lint` clean.

## State left

Both AppHosts stopped, no containers of ours running, no `/tmp/aspire-dcp*` left. `.instance/`,
`.identity/store-zenith.json`, `.identity/management.json` and `.stack/apphost-b.json` are
generated and regenerate on the next run.

Not done, and not phase 1's job: the storefront, dashboard and console still have no OIDC code
path (see `lessons/15`). Phase 2 (parameterise AppHost B by slug) is next; note `.identity/
store-zenith.json` and `.instance/zenith.json` are still the two per-slug paths AppHost B names.
