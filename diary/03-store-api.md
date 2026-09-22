# 03 — apps/store, the data plane API

**Status:** done. Every endpoint in BUILD-PLAN §6.2 exists and answers except `PATCH /api/settings`,
which is deliberately absent — see "What I did not build".

**Gate:** executed against a real `postgres:18.3`, not claimed. Transcript below.

## What I built

`packages/core` — the four modules task 03 owed everyone else:

- `src/config.ts` — the §8.2 environment contract as a Zod schema. `loadStoreConfig()` fails at
  boot naming the variable. `DEPLOYMENT_MODE=dedicated` without `TENANT_SLUG`, or
  `AUTH_ADAPTER=stub` without `AUTH_STUB_SECRET`, are boot failures rather than first-request
  failures.
- `src/tenant/resolve.ts` — `tenantCandidates(req, cfg)` and `resolveTenantCandidate(req, cfg)`.
  Takes a **request**; order is deployment → host → path (§3.6, DP). Returns the whole list as
  well as the winner, so a disagreement can be refused instead of silently resolved.
- `src/auth/plugin.ts` — the one place a token is verified and the one place a tenant is decided.
  Decorates `request.principal` and `request.tenantContext`, and exports `requireStaff(roles?)`,
  `requireShopper()` and `requireTenantContext(req)`.
- `src/http/server.ts` — `createServer()`: pino, Zod type provider, CORS, `@fastify/swagger`,
  Scalar at `/docs`, the error envelope and the auth hook. ~130 lines with the comments.

`apps/store` — the data plane. `src/app.ts` is the composition root; `src/tx.ts` is the only way a
route reaches the database:

```ts
const ctx = requireTenantContext(req);          // established by the auth hook
return runInTenant(ctx, () => withTenantTx(deps.db, fn));   // begin; set_config(...); fn
```

Routes: `health.ts` (`/health`, `/_meta`), `public.ts` (`/t/:slug/branding|products|products/:id|
orders|orders/:id`), `checkout.ts`, `staff-products.ts` (list/get/create/patch/delete),
`staff-orders.ts`, `staff-settings.ts` (`GET /api/settings`, `GET /api/licence`), `dev-login.ts`
(registered only when the adapter really is `StubAuthAdapter`). `src/licence.ts` computes the
`healthy | passive | grace | read_only` state from `licence_state`; task 08 enforces it, task 03
only reports it.

`packages/contracts` — four additions, no rewrites: `storeHealthSchema` (health also reports mode
and tenant, CE6), `deleteResultSchema`, and the `OrderLine` / `StoreHealth` / `DeleteResult`
inferred types.

`turbo.json` — `test` and `migrate` now declare `env: [DATABASE_URL, DATABASE_ADMIN_URL,
DATABASE_SUPERUSER_URL, AUTH_STUB_SECRET]`. Without that, turbo strips them and **every live-
database suite skips while the run still reports success**. See `lessons/03-store-api.md`.

`apps/store/test/api.test.ts` — 17 tests, the gate made repeatable. Skips loudly without a
database, exactly like the leak suite. `packages/core/src/tenant/resolve.test.ts` — 9 tests, no
database.

## How the three rules are actually enforced

- **BE1/BE3** — no route names a tenant. `grep -rn "tenant_id" apps/store/src` finds two comments
  and nothing else. Proof from the Postgres statement log, one `GET /api/products` request:

```
LOG:  execute <unnamed>: select "id","slug","name","branding","updated_at" from "tenants" where "tenants"."id" = $1 limit $2
LOG:  statement: begin
LOG:  execute <unnamed>: select set_config('app.tenant_id', $1, true)
LOG:  execute <unnamed>: select "id","tenant_id","sku",... from "products" order by "products"."title" asc limit $1
LOG:  statement: select count(*)::int from "products"
LOG:  execute s133k6bfm8g2: commit
```

  The tenant lookup is outside the transaction (it is what produces the context); inside it, the
  first statement is the GUC and the catalog query carries no predicate.

- **BI1** — staff tenancy comes from the token. A host or path naming another merchant is a 403
  `TENANT_MISMATCH` and never a switch.
- **BI2** — shopper tokens carry no `tid`. The tenant comes from `/t/:slug` and the subject from
  the token, and `listOrdersForSubject` joins on both.

## Gate transcript

`docker run postgres:18.3` → `pnpm --filter @mercatus/db-store migrate --seed` →
`DEPLOYMENT_MODE=pooled PORT=4002 pnpm --filter @mercatus/store start` → the curls below. Edited
only by dropping the numbered headings' blank lines.

```
### 1. health
{"status":"ok","version":"1.0.0","mode":"pooled","tenant":null}
### 2. _meta
{"mode":"pooled","version":"1.0.0","tenantCount":2,"licence":{"status":"active","state":"healthy","lastSuccessAt":null}}
### 3. public branding, acme
{"accent":"#2f6f4f","bg":"#ffffff","fg":"#14261c","name":"Acme Supply","slug":"acme"}
### 4. public catalog, acme
{"total": 4, "titles": ["Anvil, 50kg", "Giant Rubber Band"]}
### 6. POST /api/products as acme
{"id":"5f9785bd-e70e-40c5-9cd7-0950878c808e","sku":"T03-001","title":"Task 03 Widget","priceMinor":1999,"currency":"TRY","imageUrl":null,"stock":7,...}
### 7. GET /api/products as acme
{"total": 5, "skus": ["ACM-001", "ACM-004", "ACM-003", "ACM-002", "T03-001"]}
### 8. CROSS-TENANT: GET that product id as borg
{"error":{"code":"PRODUCT_NOT_FOUND","message":"No such product."}}  <- HTTP 404
### 9. CROSS-TENANT: PATCH that product as borg
{"error":{"code":"PRODUCT_NOT_FOUND","message":"No such product."}}  <- HTTP 404
### 10. CROSS-TENANT: DELETE that product as borg
{"error":{"code":"PRODUCT_NOT_FOUND","message":"No such product."}}  <- HTTP 404
### 11. the product is untouched, as acme
{"id":"5f9785bd-...","sku":"T03-001","priceMinor":1999,"stock":7,...}
### 12. checkout on acme as the shopper (2 of the new product)
{"orderId":"2a827084-69f4-4eca-8653-346932e2eda8","number":1,"totalMinor":3998,"currency":"TRY"}  <- HTTP 201
### 13. stock decremented 7 -> 5
stock: 5
### 14. staff orders as acme
{"items":[{"id":"2a827084-...","number":1,"status":"placed","totalMinor":3998,"currency":"TRY","placedAt":"2026-09-21T23:58:42.179Z"}],"total":1}
### 15. CROSS-TENANT: staff orders as borg
{"items":[],"total":0}
### 16. shopper orders at acme (same token)
{"items":[{"id":"2a827084-...","number":1,...}],"total":1}
### 17. CROSS-TENANT: the same shopper token at borg
{"items":[],"total":0}
### 18. BI1: acme's staff token on borg's public path
{"error":{"code":"TENANT_MISMATCH","message":"Not permitted."}}  <- HTTP 403
### 19. no token on a staff route
{"error":{"code":"UNAUTHENTICATED","message":"Not authenticated."}}  <- HTTP 401
### 20. shopper token on a staff route
{"error":{"code":"FORBIDDEN","message":"Not permitted."}}  <- HTTP 403
### 21. PATCH with an unknown key (.strict())
{"error":{"code":"VALIDATION_FAILED","message":"The request did not validate.","details":{"issues":[{"path":"/","message":"Unrecognized key: \"titel\""}]}}}  <- HTTP 400
### 22. PATCH the price, as acme
{"priceMinor": 2499, "stock": 9}
### 23. insufficient stock
{"error":{"code":"INSUFFICIENT_STOCK","message":"Not enough stock for \"Task 03 Widget\".","details":{"productId":"5f9785bd-...","requested":9999,"available":9}}}  <- HTTP 409
### 24. CROSS-TENANT: checkout at borg with acme's product id
{"error":{"code":"PRODUCT_NOT_FOUND","message":"No such product."}}  <- HTTP 404
### 25. order numbers are per-tenant: borg's first order is also 1
{"orderId":"465e7146-9f78-401e-97cb-4f25f572e924","number":1,"totalMinor":159900,"currency":"TRY"}
### 26. an unknown store
{"error":{"code":"TENANT_NOT_FOUND","message":"Unknown store."}}  <- HTTP 404
### 27. /api/licence and /api/settings as acme
{"status":"active","state":"healthy","entitlements":{},"validUntil":null,"lastCheckedAt":null,"lastSuccessAt":null}
{"name":"Acme Supply","slug":"acme","branding":{"accent":"#2f6f4f","bg":"#ffffff","fg":"#14261c"}}
### 28. docs
/docs -> 301   /docs/openapi.json -> 200 (paths: 16)

### 29. host-based tenancy (tier 2 seam): Host: acme.localtest.me with acme's token
{"items":[{"sku":"ACM-001","title":"Anvil, 50kg",...}]}  <- HTTP 200
### 30. same host with BORG's token -- BI1 refusal, not a switch
{"error":{"code":"TENANT_MISMATCH","message":"Not permitted."}}  <- HTTP 403
### 31. reserved label admin.localtest.me is not a tenant candidate
{"total": 3, "skus": ["BRG-001", "BRG-003"]}          (borg's token still serves borg)
```

Then the same process, same code, `DEPLOYMENT_MODE=dedicated TENANT_SLUG=acme PORT=4003` (CC1):

```
### 32. /health names its tenant
{"status":"ok","version":"1.0.0","mode":"dedicated","tenant":"acme"}
### 33. /_meta reports that tenant's licence
{"mode":"dedicated","version":"1.0.0","tenantCount":2,"licence":{"status":"active","state":"healthy","lastSuccessAt":null}}
### 35. the pinned tenant's catalog
{"total": 5, "first": "ACM-001"}
### 36. another merchant's slug in the URL is a refusal, not a switch
{"error":{"code":"TENANT_MISMATCH","message":"Not permitted."}}  <- HTTP 403
### 37. a token for a tenant this instance does not serve
{"error":{"code":"TENANT_MISMATCH","message":"Not permitted."}}  <- HTTP 403
```

And the suites, with the database env actually reaching them:

```
pnpm turbo run test --force
@mercatus/core:test        18 passed (2 files)
@mercatus/contracts:test   25 passed
@mercatus/db-platform:test 10 passed
@mercatus/db-store:test    69 passed (4 files — nothing skipped)
@mercatus/store:test       17 passed
pnpm check  →  17 tasks successful
```

## What I did not build, and why

- **`PATCH /api/settings`.** `tenants` is the one table without RLS, so the app role holds SELECT
  on it and nothing else; an UPDATE grant would be a cross-tenant **write** surface on a table
  with no policy to scope it. Name and branding are control-plane facts mirrored down (BV1), so
  the edit belongs on the control plane, which re-mirrors. Task 07 owns that; the dashboard
  (task 06) should read `GET /api/settings` and point its form at the platform API.
- **`src/agents/licence-poll.ts`, `src/agents/heartbeat.ts`, `src/plugins/licence-gate.ts`.**
  Tasks 08 and 10. `src/licence.ts` already computes the state both will need.
- **The 402 on checkout when passive.** Same reason. It goes in front of the handler as a
  preHandler, not inside it.

## What the next agent needs to know

1. **`pnpm check` and `pnpm turbo run test` now pass the database variables through.** If you add
   a task that needs an env var, add it to that task's `env` list in `turbo.json` or it will be
   invisible and your suite will skip while the run stays green.
2. **The store's routes are already there for tasks 04–06.** The storefront wants
   `/t/:slug/branding`, `/t/:slug/products`, `/t/:slug/products/:id`, `/t/:slug/checkout`; the
   dashboard wants `/api/products`, `/api/orders`, `/api/licence`, `/api/settings` and
   `/dev/login/staff`. Shapes are in `@mercatus/contracts`; the OpenAPI document at
   `/docs/openapi.json` is generated from exactly those.
3. **Scalar serves at `/docs/` (note the trailing slash — `/docs` is a 301) and the document at
   `/docs/openapi.json`.** Not `/documentation/json`.
4. **Get tokens from `/dev/login/staff` `{slug, role}` and `/dev/login/shopper` `{phone}`.** Both
   return `{ accessToken, expiresAt }`. The staff token is tenant-scoped; the shopper token is
   deliberately not, so a shopper request must also carry `/t/:slug`.
5. **`createServer()` from `@mercatus/core` is how the platform and fake-bank should boot too**
   (task 07). Pass `auth: { adapter }` with no `tenants`/`deployment` for a service that has no
   tenancy of its own, and the hook will verify tokens without attempting a tenant decision.
6. **`loadStoreConfig()` is store-shaped.** Task 07 should add `loadPlatformConfig()` beside it in
   `packages/core/src/config.ts` rather than parsing `process.env` in a route.
7. Machine left as found: `mercatus-store-03` removed, nothing listening on 4002/4003,
   `docker ps` shows only the unrelated `chess-trainer`.
