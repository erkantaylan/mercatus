# BUILD-PLAN — the file-by-file plan for the POC

**Written by task 00 (recon). Later agents build against this document.** Where this document and
your instinct disagree, this document wins — divergence between agents is more expensive than a
slightly wrong name. Where this document and
[`architecture.md`](./architecture.md) / [`../README.md`](../README.md) disagree, the deviation is
listed in [`decisions-made-overnight.md`](./decisions-made-overnight.md) with its reason.

Rules referenced as `BE1`, `CC1`, `CG3`, … are in [`dos-and-donts.md`](./dos-and-donts.md).

> **The domain is four nouns.** A product has a title, price, image url and stock. A basket lives
> in the browser. Checkout creates an order. The dashboard lists orders. Nothing else. No
> variants, no categories, no discounts, no shipping, no tax, no refunds. If you find yourself
> adding a fifth noun, stop.

---

## 0. Verified toolchain (task 00, 2026-09-22)

| | Version | Note |
|---|---|---|
| node | 22.23.2 | via nvm at `~/.nvm/versions/node/v22.23.2/bin` |
| pnpm | 12.5.1 | installed by `corepack prepare pnpm@latest --activate`; on PATH in a fresh login shell |
| dotnet SDK | 10.0.110 | |
| aspire CLI | 13.5.3 | AppHost SDK resolves to **13.5.4** |
| docker | 29.7.2 | Ubuntu 24.04.4 |
| postgres image | `postgres:18.3` | what Aspire's `AddPostgres` pulls |

Verified by running, not by reading:

- `aspire run --detach` starts an AppHost, prints JSON with `appHostPid` and `dashboardUrl`, and
  `aspire stop` shuts it and its containers down cleanly.
- Postgres RLS driven by `set_config('app.tenant_id', $1, true)` isolates correctly, including
  from a parameterised statement. See §3.

---

## 1. Repository layout

```
mercatus/
  package.json                 # private root, workspace scripts only
  pnpm-workspace.yaml          # packages + catalog (single place versions are pinned)
  turbo.json
  tsconfig.base.json
  eslint.config.js             # flat config, shared by every package
  .npmrc
  apps/
    platform/                  # @mercatus/platform    Fastify   control plane
    store/                     # @mercatus/store       Fastify   data plane, one image two modes
    fake-bank/                 # @mercatus/fake-bank   Fastify   run-mode only
    dashboard/                 # @mercatus/dashboard   Vite + React + TanStack Router (SPA)
    admin/                     # @mercatus/admin       Vite + React + TanStack Router (SPA)
    storefront/                # @mercatus/storefront  Next.js App Router
  packages/
    core/                      # @mercatus/core        tenant context, auth adapter, errors, config, http client
    contracts/                 # @mercatus/contracts   Zod schemas + inferred types
    db-platform/               # @mercatus/db-platform Drizzle schema + migrations, control plane
    db-store/                  # @mercatus/db-store    Drizzle schema + migrations + RLS, data plane
    ui/                        # @mercatus/ui          design tokens + shared React components
  aspire/
    control-plane/             # AppHost A: apphost.cs, apphost.run.json, aspire.config.json
    acme-vps/                  # AppHost B: the dedicated instance, "their server"
  diary/                       # one file per task, written after
  lessons/                     # read every file before you start
  docs/
```

`packages/clients` from the README is **not built** — see `decisions-made-overnight.md`.
`packages/ui` takes its place in the layout.

### Package naming

Every workspace package is `@mercatus/<dirname>`. Every one is `"private": true`, `"type":
"module"`, and has exactly these scripts where they apply: `dev`, `build`, `typecheck`, `lint`,
`test`. Turbo drives them; nothing else.

Internal imports are by package name (`@mercatus/core`), never by relative path across a package
boundary. Packages export TypeScript source directly via `"exports": { ".": "./src/index.ts" }`
and are consumed by `tsx` / Vite / Next without a build step. Only the three Fastify apps produce
a `dist/`, and only for the Dockerfile.

---

## 2. Versions — the pnpm catalog

Pin these in `pnpm-workspace.yaml` under `catalog:` and reference them everywhere as
`"fastify": "catalog:"`. Versions resolved and checked 2026-09-22.

```yaml
packages:
  - apps/*
  - packages/*

catalog:
  # runtime
  fastify: 5.12.5
  "@fastify/cors": 11.3.0
  "@fastify/swagger": 9.8.2
  "@scalar/fastify-api-reference": 1.70.0
  fastify-type-provider-zod: 7.0.0
  zod: 4.6.5
  drizzle-orm: 0.45.3
  postgres: 3.4.9
  pino: 10.3.1
  jose: 6.2.12

  # frontend
  react: 19.3.0
  react-dom: 19.3.0
  next: 16.3.5
  vite: 8.3.0
  "@vitejs/plugin-react": 6.1.1
  "@tanstack/react-router": 1.170.38
  "@tanstack/router-plugin": 1.168.40
  "@tanstack/react-query": 5.103.2

  # tooling
  typescript: 5.9.3
  tsx: 4.23.15
  turbo: 2.11.2
  drizzle-kit: 0.31.11
  vitest: 5.0.1
  eslint: 10.11.0
  typescript-eslint: 8.70.1
  "@types/node": ^22.0.0
  "@types/react": ^19.0.0
  "@types/react-dom": ^19.0.0
```

**Do not take `typescript@latest`.** npm `latest` is **7.0.2**, and `typescript-eslint@8.70.1`
declares `peerDependencies.typescript: ">=4.8.4 <6.1.0"`. TypeScript 7 breaks linting on
install. `5.9.3` is the pin. Likewise `@types/node` must track Node **22**, not `latest` (26.x).

If a version here turns out to be wrong, fix the catalog, run the build, and write the correction
in `lessons/`.

---

## 3. Tenant context — the exact mechanism

This is the load-bearing decision of the whole POC (`BE1`, `BE3`). Every agent depends on it, so
it is specified down to the SQL.

### 3.1 `packages/core/src/tenant/context.ts`

```ts
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantContext {
  /** uuid from tenants.id. Never a slug. */
  readonly tenantId: string;
  readonly slug: string;
  /** where the tenant came from, for audit and for BI1/BI2 assertions */
  readonly source: 'token' | 'route' | 'deployment';
  /** token subject, when the request is authenticated. Required for shopper scoping (BI2). */
  readonly subject?: string;
}

const storage = new AsyncLocalStorage<TenantContext>();

export function runInTenant<T>(ctx: TenantContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

/** Throws MissingTenantContextError. Fail loudly; never default to "some tenant". */
export function currentTenant(): TenantContext {
  const ctx = storage.getStore();
  if (!ctx) throw new MissingTenantContextError();
  return ctx;
}

export function tryCurrentTenant(): TenantContext | undefined {
  return storage.getStore();
}
```

### 3.2 `packages/db-store/src/tenant-tx.ts` — the Drizzle wrapper

```ts
/**
 * Every data-plane query goes through here. The tenant is pushed into the transaction, and
 * Postgres RLS — not this code — decides what the query can see (BE1).
 *
 * set_config(name, value, is_local => true) is exactly SET LOCAL, but it is a function call, so
 * the tenant id binds as a parameter. `SET LOCAL app.tenant_id = $1` is not valid SQL; SET does
 * not take bind parameters. Do not build that statement by interpolation.
 */
export async function withTenantTx<T>(db: StoreDb, fn: (tx: StoreTx) => Promise<T>): Promise<T> {
  const { tenantId } = currentTenant();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
```

### 3.3 The policy, on every data-plane table but one

```sql
alter table <t> enable row level security;
alter table <t> force row level security;
create policy <t>_tenant_isolation on <t>
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

**The `nullif` is not decoration.** Verified on `postgres:18.3`: after a transaction that did
`SET LOCAL app.tenant_id`, the setting reverts to the **empty string**, not to NULL, for the rest
of that session. Without `nullif`, a pooled connection that served one tenant-scoped request and
is then reused for a query outside tenant context raises
`ERROR: invalid input syntax for type uuid: ""` — nondeterministically, depending on whether the
connection is fresh. With `nullif`, no context always means **zero rows**. Fail closed, quietly,
every time.

Also verified: `with check` blocks a cross-tenant **write** from inside a correctly-scoped
transaction (`new row violates row-level security policy`).

### 3.4 Roles (`BE2`)

Two roles in the store database, created by `packages/db-store/sql/00-roles.sql`, applied before
migrations:

| Role | Used by | Attributes |
|---|---|---|
| `mercatus_owner` | drizzle-kit migrations, seed | owns the schema |
| `mercatus_app` | store-api at runtime | `LOGIN NOBYPASSRLS`, granted only `select, insert, update, delete` on the tables |

`DATABASE_ADMIN_URL` connects as owner and is used **only** by the migrate step.
`DATABASE_URL` connects as `mercatus_app` and is the only one the server process gets. A superuser
bypasses RLS regardless of `FORCE`, so running the app as `postgres` silently disables every
policy — this is the failure `BE2` is about.

### 3.5 The rule that makes it worth having

**No application query anywhere in `apps/store` writes `where tenant_id = …`.** Not as belt and
braces, not "just to be explicit". The whole value of `BE1` is that a forgotten filter returns
nothing instead of another tenant's data, and you cannot test that property if the filters are
there. The leak suite (§9) greps for it.

The one exception is `packages/db-store/src/tenants.ts`, and it is commented as such.

### 3.6 Tenant resolution — `packages/core/src/tenant/resolve.ts`

Takes a **request**, not a route parameter, so tier 2 is later a `domains` table rather than a
rewrite (`DP`).

```ts
export interface TenantCandidate { slug: string; source: 'deployment' | 'host' | 'path'; }

export function resolveTenantCandidate(
  req: { hostname: string; url: string },
  cfg: { mode: 'pooled' | 'dedicated'; tenantSlug?: string; baseHost: string },
): TenantCandidate | null;
```

Order: `deployment` (dedicated mode is pinned to `TENANT_SLUG`) → `host` (a label under
`baseHost`, e.g. `acme.localtest.me`, excluding the reserved labels `platform`, `id`, `admin`,
`bank`) → `path` (`/t/:slug`). First hit wins.

**The candidate is a candidate.** For staff requests the tenant comes from the token, and a
candidate that disagrees with the token is a **403, never a switch** (`BI1`).

---

## 4. Auth — the adapter interface

Behind an interface from day one; a stub until the Identity phase. `packages/core/src/auth/`.

### 4.1 `types.ts`

```ts
export interface StaffPrincipal {
  kind: 'staff';
  /** stable subject from the issuer */
  subject: string;
  /** tenant-scoped token (BC1). Exactly one tenant, never a list of memberships. */
  tenantId: string;
  roles: readonly ('owner' | 'staff')[];
  /** epoch seconds */
  expiresAt: number;
}

export interface ShopperPrincipal {
  kind: 'shopper';
  subject: string;
  /** deliberately tenant-less (Q20, BI2). The tenant comes from the route; both are enforced. */
  tenantId: null;
  expiresAt: number;
}

export type Principal = StaffPrincipal | ShopperPrincipal;

export interface AuthAdapter {
  readonly name: 'stub' | 'oidc';

  /**
   * Verify a bearer token with no network call (cached keys only) — a dedicated instance must
   * do this while the control plane is down (CG1). Returns null for absent, malformed, expired
   * or badly-signed tokens. Never throws for a bad token; throws only for a broken adapter.
   */
  verify(token: string): Promise<Principal | null>;

  /** Where to send the browser to start an interactive login. */
  authorizeUrl(p: {
    redirectUri: string;
    audience: 'staff' | 'shopper';
    /** selects the organization for a staff login; ignored for shoppers */
    tenantSlug?: string;
    state: string;
  }): Promise<string>;

  /** Exchange an authorization code. Needs the issuer to be reachable. */
  exchange(p: { code: string; redirectUri: string }): Promise<{
    principal: Principal;
    accessToken: string;
    refreshToken?: string;
  }>;

  /** Mint a tenant-scoped staff token (BC1). Switching tenants calls this, not a wider token. */
  tokenForTenant(p: { refreshToken: string; tenantId: string }): Promise<{
    principal: StaffPrincipal;
    accessToken: string;
  }>;

  /** Feeds the degradation state machine (CG1, CG3). Must not throw. */
  issuerReachable(): Promise<boolean>;
}
```

### 4.2 `stub-adapter.ts`

`StubAuthAdapter` implements all of it with `jose`, HS256, secret from `AUTH_STUB_SECRET`.
`authorizeUrl` returns a local dev page; `exchange` accepts any code of the form
`stub:<kind>:<subject>[:<tenantSlug>]`; `issuerReachable()` returns true. Refuses to construct
when `NODE_ENV === 'production'`.

### 4.3 `oidc-adapter.ts` — Identity phase, not the overnight scope

Logto, `jose` `createRemoteJWKSet` with a **disk-cached** key set so verification survives the
control plane being down. One issuer only (`CD4`).

### 4.4 Selection and use

`createAuthAdapter(config): AuthAdapter` switches on `AUTH_ADAPTER`. **No route handler ever sees
the adapter.** A Fastify plugin `packages/core/src/auth/plugin.ts`:

1. reads `Authorization: Bearer`, calls `verify`
2. decorates `request.principal: Principal | null`
3. establishes tenant context per §3.6 and the `BI1`/`BI2` split
4. exposes `requireStaff(roles?)` and `requireShopper()` as route `preHandler`s

Auth-shaped failures return **one generic code** and log which check actually failed (`S1`).

---

## 5. Databases

Money is always an **integer in minor units** (`price_minor`, `total_minor`, `amount_minor`),
never a float, never `numeric`. Currency is a separate `text` column defaulting to `'TRY'`.
All ids are `uuid` with `default gen_random_uuid()` unless stated. All timestamps are
`timestamptz`.

### 5.1 `packages/db-platform` — control plane, database `platform`

No RLS: this database has one tenant, us. Files:
`src/schema.ts`, `src/client.ts`, `src/seed.ts`, `drizzle.config.ts`, `migrations/`.

**`users`**

| column | type | note |
|---|---|---|
| `id` | uuid pk | |
| `phone` | text not null unique | the login identity |
| `name` | text not null | |
| `created_at` | timestamptz not null default now() | |

**`tenants`** — the platform's own tenant id is minted here (`BV1`)

| column | type | note |
|---|---|---|
| `id` | uuid pk | never an external system's key |
| `slug` | text not null unique | what appears in URLs (`BV3`) |
| `name` | text not null | store display name |
| `status` | text not null | `pending` \| `active` \| `passive` |
| `tier` | text not null | `pooled` \| `dedicated` |
| `payment_ref` | text null | fake-bank reference — an **attribute** (`BV1`) |
| `created_at` | timestamptz not null default now() | |
| `activated_at` | timestamptz null | set by the payment callback |

**`memberships`** — `(user_id, tenant_id, role)` from day one (`BA1`)

| column | type | note |
|---|---|---|
| `user_id` | uuid not null fk users(id) | |
| `tenant_id` | uuid not null fk tenants(id) | |
| `role` | text not null | `owner` \| `staff` |
| `created_at` | timestamptz not null default now() | |
| | primary key `(user_id, tenant_id)` | |

**`licences`**

| column | type | note |
|---|---|---|
| `tenant_id` | uuid pk fk tenants(id) | one licence per tenant |
| `entitlements` | jsonb not null default `'{}'` | e.g. `{"hidePoweredBy": true}` — features gate on this, never on a build (`CC3`) |
| `valid_until` | date not null | |
| `issued_at` | timestamptz not null default now() | |

**`installations`** — a dedicated instance that registered itself

| column | type | note |
|---|---|---|
| `id` | uuid pk | |
| `tenant_id` | uuid not null fk tenants(id) | |
| `bootstrap_token_hash` | text null | sha256 of a one-time token; nulled on first use |
| `instance_token_hash` | text null | per-instance credential, revocable (`CE1`) |
| `version` | text null | reported, never assumed (`CE6`) |
| `last_seen_at` | timestamptz null | from the heartbeat |
| `product_count` | integer not null default 0 | reported, treated as telemetry (`CE3`) |
| `order_count` | integer not null default 0 | same |
| `registered_at` | timestamptz null | |
| `created_at` | timestamptz not null default now() | |

**`payments`** — buying a store

| column | type | note |
|---|---|---|
| `id` | uuid pk | |
| `tenant_id` | uuid not null fk tenants(id) | |
| `provider_ref` | text not null | fake-bank's id |
| `amount_minor` | integer not null | |
| `currency` | text not null default `'TRY'` | |
| `status` | text not null | `created` \| `paid` \| `declined` |
| `created_at` | timestamptz not null default now() | |
| `settled_at` | timestamptz null | |

No `domains` table in the POC — tier 2 is out (`DP`). The seam is in §3.6.

### 5.2 `packages/db-store` — data plane, database `store`

**Identical in pooled and dedicated** (`CC2`). Files: `src/schema.ts`, `src/client.ts`,
`src/tenant-tx.ts`, `src/repositories/*.ts`, `src/seed.ts`, `sql/00-roles.sql`,
`sql/02-rls.sql`, `drizzle.config.ts`, `migrations/`.

**`tenants`** — the one table **without** RLS, because it is the lookup that establishes context

| column | type | note |
|---|---|---|
| `id` | uuid pk | mirrored from the control plane, not minted here |
| `slug` | text not null unique | |
| `name` | text not null | |
| `branding` | jsonb not null default `'{}'` | `{logoUrl, accent, bg, fg}` → CSS custom properties (`DW`) |
| `updated_at` | timestamptz not null default now() | |

`mercatus_app` is granted `select` only. Rationale goes in a comment in the schema (`AG1`).

**`licence_state`** — what this store believes about its licence (`CG3`). RLS on.

| column | type | note |
|---|---|---|
| `tenant_id` | uuid pk | |
| `status` | text not null default `'active'` | `active` \| `passive` |
| `entitlements` | jsonb not null default `'{}'` | |
| `valid_until` | date null | |
| `last_checked_at` | timestamptz null | attempt |
| `last_success_at` | timestamptz null | drives the grace window |

**`products`** — RLS on

| column | type | note |
|---|---|---|
| `id` | uuid pk | |
| `tenant_id` | uuid not null | |
| `sku` | text not null | |
| `title` | text not null | |
| `price_minor` | integer not null | |
| `currency` | text not null default `'TRY'` | |
| `image_url` | text null | |
| `stock` | integer not null default 0 | |
| `created_at` | timestamptz not null default now() | |
| `updated_at` | timestamptz not null default now() | |
| | `unique (tenant_id, sku)` | composite, never global (`BG1`) |

**`shoppers`** — rows in the store, not users of the platform (`CD3`). RLS on.

| column | type | note |
|---|---|---|
| `id` | uuid pk | |
| `tenant_id` | uuid not null | |
| `subject` | text not null | token `sub`; the `BI2` second condition |
| `phone` | text not null | |
| `name` | text null | |
| `created_at` | timestamptz not null default now() | |
| | `unique (tenant_id, phone)`, `unique (tenant_id, subject)` | both composite (`BG1`) |

**`orders`** — RLS on

| column | type | note |
|---|---|---|
| `id` | uuid pk | |
| `tenant_id` | uuid not null | |
| `number` | bigint not null | per-tenant, gapless (`BG2`) |
| `shopper_id` | uuid not null fk shoppers(id) | |
| `status` | text not null default `'placed'` | `placed` \| `paid` \| `cancelled` |
| `total_minor` | integer not null | |
| `currency` | text not null default `'TRY'` | |
| `placed_at` | timestamptz not null default now() | |
| | `unique (tenant_id, number)` | |

**`order_lines`** — RLS on. Carries `tenant_id` even though it could be reached through `orders`,
because `BE4` is about checking each store separately and a policy on the parent is not a policy
on the child.

| column | type | note |
|---|---|---|
| `id` | uuid pk | |
| `tenant_id` | uuid not null | |
| `order_id` | uuid not null fk orders(id) | |
| `product_id` | uuid not null fk products(id) | |
| `title_snapshot` | text not null | the title at order time |
| `unit_price_minor` | integer not null | the price at order time |
| `qty` | integer not null check (`qty > 0`) | |

**`order_counters`** — RLS on. One row per tenant (`BG2`).

| column | type | note |
|---|---|---|
| `tenant_id` | uuid pk | |
| `next_number` | bigint not null default 1 | |

Taken inside the order transaction as
`select next_number from order_counters for update` — **no `where` clause**, RLS scopes it (§3.5)
— then `update order_counters set next_number = next_number + 1`. Assert exactly one row came
back; zero rows means the tenant context was never established, which is a bug, not an empty
result. Never a Postgres sequence: sequences do not roll back, so numbering would be neither
per-tenant nor gapless.

### 5.3 Migrations

`drizzle-kit generate` then `drizzle-kit migrate`, run as an **init step**, never in-process.
Each db package exposes `pnpm --filter @mercatus/db-store migrate`, which runs, in order:
`sql/00-roles.sql` → drizzle migrations → `sql/02-rls.sql` → optional `src/seed.ts`.

Express the policies with Drizzle's `pgPolicy` if it cooperates; if it fights, hand-author
`sql/02-rls.sql` and keep it generated-free. **Never hand-edit a generated migration** (`J1`) —
change the schema and regenerate.

### 5.4 Seed

`db-store` seeds two pooled tenants, so every fixture has a second tenant to leak into (`BL1`):

| slug | name | products |
|---|---|---|
| `acme` | Acme Supply | 4 |
| `borg` | Borg Outfitters | 3 |

`db-platform` seeds the matching `tenants` (status `active`, tier `pooled`), one `users` row
(`+905550000000`, "Dev Owner"), `memberships` as `owner` on both, and an `active` licence for each
with `valid_until` a year out. The dedicated tenant `zenith` is created by the buy-a-store flow or
by `POST /installations`, not by the seed.

---

## 6. HTTP APIs

### 6.0 Shared conventions

- **Error envelope**, every non-2xx, everywhere:
  `{ "error": { "code": "PRODUCT_NOT_FOUND", "message": "…", "details": {…}? } }`
  Codes are a Zod enum in `@mercatus/contracts/errors.ts`. Never leak a stack.
- **Validation** is Zod via `fastify-type-provider-zod`; the schema is the contract.
- **OpenAPI** from those schemas via `@fastify/swagger`, served at `/docs` by
  `@scalar/fastify-api-reference`. Generation stops at documentation — no client codegen.
- **Lists** return `{ items: T[], total: number }`. No cursors; the POC has no page that needs one.
- **Composition helper** `createServer(opts)` in `packages/core/src/http/server.ts` wires pino,
  the error handler, CORS, swagger, Scalar and the auth plugin. It is fifty lines, not a framework.

### 6.1 `apps/platform` — control plane (default port 4001)

```
src/index.ts                 bootstrap
src/routes/health.ts
src/routes/signup.ts
src/routes/payments.ts
src/routes/tenants.ts
src/routes/licence.ts
src/routes/installations.ts
src/routes/telemetry.ts
src/services/*.ts
```

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | `{ status, version }` |
| POST | `/signup` | none | `{ phone, name, storeName, slug, tier }` → creates the user if new, the tenant as `pending`, and a fake-bank payment. Returns `{ tenantId, slug, paymentUrl }`. Signup creates; payment activates |
| POST | `/payments/callback` | HMAC | fake-bank's signed callback. Verify the signature, mark the payment `paid`, set tenant `active` + `activated_at`, issue the licence. Idempotent by `provider_ref` (`CK2`) → 204 |
| POST | `/payments/proxy` | instance token | a dedicated plane's checkout payment. Our credentials stay here (`CE2`) |
| GET | `/tenants` | staff (admin audience) | list with licence status, tier, last heartbeat |
| GET | `/tenants/:slug` | staff (admin audience) | one |
| POST | `/tenants/:slug/licence` | staff (admin audience) | `{ status: 'active'\|'passive', validUntil? }` — the console's flip (`CG3`, `ES`) |
| GET | `/tenants/:slug/licence` | instance token **or** internal | what a data plane polls: `{ status, entitlements, validUntil, serverTime }` |
| POST | `/installations` | staff (admin audience) | `{ tenantSlug }` → `{ installationId, bootstrapToken }`, shown **once** |
| POST | `/installations/register` | bootstrap token | `{ bootstrapToken, version }` → `{ installationId, instanceToken }`, per-instance and revocable (`CE1`). Burns the bootstrap token |
| POST | `/telemetry/heartbeat` | instance token | `{ version, tenantId, licenceId, productCount, orderCount }` → updates `installations`. Scrub at source — no shopper data ever (`CI1`) |
| GET | `/docs` | none | Scalar |

### 6.2 `apps/store` — data plane (pooled 4002, dedicated 4003)

One image, `DEPLOYMENT_MODE=pooled|dedicated`, **no second code path** (`CC1`).

```
src/index.ts
src/routes/health.ts
src/routes/public.ts          # /t/:slug/*
src/routes/checkout.ts
src/routes/staff-products.ts  # /api/products
src/routes/staff-orders.ts    # /api/orders
src/routes/staff-settings.ts
src/routes/dev-login.ts       # AUTH_ADAPTER=stub only
src/agents/licence-poll.ts    # CE4: pull, never be pushed to
src/agents/heartbeat.ts       # CE6
src/plugins/licence-gate.ts   # CG3 + grace state machine
```

Shopper / public surface — tenant from the **route**, subject from the **token**, and both
conditions always applied (`BI2`):

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | |
| GET | `/_meta` | none | `{ mode, version, tenantCount, licence: { status, state, lastSuccessAt } }` — the degradation demo reads this |
| GET | `/t/:slug/branding` | none | `{ name, logoUrl, accent, bg, fg }` |
| GET | `/t/:slug/products` | none | public catalog, `{ items, total }`, stock included |
| GET | `/t/:slug/products/:id` | none | |
| POST | `/t/:slug/checkout` | shopper (stub: phone) | `{ lines: [{ productId, qty }], shopper: { phone, name } }` → one transaction: upsert shopper, take the order number, insert order + lines, decrement stock. Returns `{ orderId, number, totalMinor }`. **402 `LICENCE_PASSIVE`** when the licence is passive. 409 `INSUFFICIENT_STOCK` |
| GET | `/t/:slug/orders` | shopper | that shopper's orders only |
| GET | `/t/:slug/orders/:id` | shopper | 404, never 403, for someone else's order |

Staff surface — tenant from the **token**; a route/host that disagrees is 403 (`BI1`):

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/products` | staff | |
| POST | `/api/products` | staff | `{ sku, title, priceMinor, imageUrl?, stock }` |
| PATCH | `/api/products/:id` | staff | any subset of the above |
| DELETE | `/api/products/:id` | staff | |
| GET | `/api/orders` | staff | `{ items, total }`, newest first |
| GET | `/api/orders/:id` | staff | with lines |
| GET | `/api/licence` | staff | what the store believes, and why |
| GET | `/api/settings` | staff | `{ name, branding }` |
| PATCH | `/api/settings` | staff (`owner`) | |

Dev only, refuses to register unless `AUTH_ADAPTER=stub`:

| Method | Path | Purpose |
|---|---|---|
| POST | `/dev/login/staff` | `{ slug, role }` → a tenant-scoped staff token |
| POST | `/dev/login/shopper` | `{ phone }` → a tenant-less shopper token |

### 6.3 `apps/fake-bank` (port 4004)

Refuses to start unless `MERCATUS_ALLOW_FAKE_BANK=1`. Only the AppHosts set it (`CR1`).

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | |
| POST | `/payments` | `{ amountMinor, currency, reference, callbackUrl, signature }`. **Verifies our HMAC before answering** — a break in our signing shows up here, on a laptop |
| GET | `/pay/:id` | a plain HTML page: Pay, Decline, and a behaviour selector |
| POST | `/pay/:id/complete` | `{ behaviour: 'approve' \| 'decline' \| 'bad-hash' \| 'no-callback' \| 'drop' }` → posts the signed callback, or deliberately does not |
| GET | `/payments/:id` | state, for tests |

In-memory store. No database.

### 6.4 The degradation state machine (`CG1`, `CG2`, `CG3`)

`src/plugins/licence-gate.ts` computes one of four states per request from `licence_state`:

| State | Condition | Storefront | Dashboard |
|---|---|---|---|
| `healthy` | `last_success_at` within `3 × LICENCE_POLL_SECONDS` | full | full |
| `passive` | `status = 'passive'` (fresh **or** cached) | browse; checkout → **402 `LICENCE_PASSIVE`** | **fully usable** |
| `grace` | unreachable, within `LICENCE_GRACE_SECONDS` | full | full |
| `read_only` | unreachable, grace expired | browse; checkout → **503 `CONTROL_PLANE_UNREACHABLE`** | GET only; writes → 503 |

Written-down numbers, per `CG2`: **poll every 10s; grace 72h in `LICENCE_GRACE_SECONDS`
(259200), overridden to 60 in the demo profile; JWKS cached 24h and served stale indefinitely
while the issuer is unreachable.** Never a hard stop — `read_only` is the terminal state.

`passive` and `unreachable` are separate columns' worth of truth and must never be collapsed: one
is the merchant's fault and leaves them the page that fixes it, the other is ours.

---

## 7. Front ends

### 7.1 `packages/ui` — plain CSS, design tokens, one small component set

No component library, no Tailwind, no CSS-in-JS. Consistent and plain beats pretty.

```
src/tokens.css        the only place a colour or a spacing value is written
src/reset.css
src/components/Button.tsx        + Button.css
src/components/Input.tsx         + Input.css
src/components/Field.tsx         label + error + hint
src/components/Table.tsx         header/row/cell, no sorting
src/components/Card.tsx
src/components/Banner.tsx        info | warning | danger — the passive-licence banner
src/components/PageHeader.tsx
src/components/EmptyState.tsx
src/components/Money.tsx         minor units + currency → a string
src/components/Spinner.tsx
src/index.ts
```

`tokens.css` defines, on `:root`:
`--mc-bg`, `--mc-surface`, `--mc-fg`, `--mc-fg-muted`, `--mc-border`, `--mc-accent`,
`--mc-accent-fg`, `--mc-danger`, `--mc-warning`, `--mc-success`,
`--mc-space-1` … `--mc-space-6`, `--mc-radius`, `--mc-radius-lg`,
`--mc-font-sans`, `--mc-font-mono`, `--mc-text-sm|base|lg|xl`, `--mc-shadow`.

Per-tenant branding (`DW`) overrides `--mc-accent`, `--mc-bg`, `--mc-fg` on a wrapper element
from the `branding` jsonb. That is the entire theming story; no custom templates.

### 7.2 `apps/storefront` — Next.js App Router (pooled 3001, dedicated 3002)

```
app/layout.tsx                        imports tokens.css
app/page.tsx                          dedicated: redirect to /t/$TENANT_SLUG. pooled: a store index
app/t/[slug]/layout.tsx               fetches branding, sets the CSS custom properties
app/t/[slug]/page.tsx                 product grid
app/t/[slug]/p/[id]/page.tsx          product detail, add to basket
app/t/[slug]/basket/page.tsx          client component
app/t/[slug]/checkout/page.tsx        phone + name → POST checkout
app/t/[slug]/order/[id]/page.tsx      confirmation
app/t/[slug]/orders/page.tsx          this shopper's orders
components/BasketButton.tsx
components/ProductCard.tsx
components/PassiveBanner.tsx          shown when the licence is passive; checkout disabled
lib/basket.ts                         localStorage, key `mercatus.basket.<slug>`
lib/api.ts                            typed fetch against @mercatus/contracts
lib/session.ts                        shopper token in an httpOnly cookie set by a route handler
```

The basket is **browser state only** — an array of `{ productId, qty }` in localStorage, prices
re-fetched on render, totals recomputed at checkout server-side. Never trust a posted price.

Dedicated mode is one environment variable (`TENANT_SLUG`) and no new code (`CC1`).

### 7.3 `apps/dashboard` — Vite + React + TanStack Router SPA (pooled 5173, dedicated 5175)

Ships with the instance; the only difference between the two deployments is `VITE_STORE_API_URL`
(`DK`).

```
src/main.tsx
src/router.tsx                        createRouter, file-based routes via @tanstack/router-plugin
src/routes/__root.tsx                 shell, nav, licence banner
src/routes/index.tsx                  redirect → /products
src/routes/login.tsx                  stub login: slug + role
src/routes/products.index.tsx         table
src/routes/products.new.tsx           form
src/routes/products.$id.tsx           edit + delete
src/routes/orders.index.tsx           table: number, date, shopper phone, total, status
src/routes/orders.$id.tsx             lines
src/routes/settings.tsx               store name + branding
src/api/client.ts                     fetch + Zod parse, bearer from the session
src/auth/session.ts                   access token in memory, refresh in localStorage
src/lib/licence.ts                    reads /api/licence → banner state
vite.config.ts                        server.port 5173, strictPort
```

### 7.4 `apps/admin` — platform console, Vite + React + TanStack Router SPA (5174)

A **separate app with a separate token audience** — never one app with an `isStaff` flag (`BH1`).

```
src/routes/__root.tsx
src/routes/index.tsx                  redirect → /tenants
src/routes/login.tsx
src/routes/tenants.index.tsx          slug, tier, status, licence, last heartbeat
src/routes/tenants.$slug.tsx          detail; the active/passive flip (CG3); installations
src/routes/installations.index.tsx    create one, show the bootstrap token once
src/routes/payments.index.tsx         buy-a-store payments and their state
```

Every cross-tenant read an operator performs is logged with the operator and the reason (`BH2`) —
in the POC, a `pino` line with `{ operator, tenantId, reason }` is enough.

---

## 8. Orchestration

### 8.1 Ports

| Resource | Port | Note |
|---|---|---|
| Traefik (AppHost A edge) | **8090** | **not 8080** — `qbittorrent` holds 8080 on this machine |
| storefront, pooled | 3001 | **never 3000**, `livemd` holds it |
| storefront, dedicated | 3002 | |
| dashboard, pooled | 5173 | |
| admin console | 5174 | |
| dashboard, dedicated | 5175 | |
| platform API | 4001 | |
| store-api, pooled | 4002 | |
| store-api, dedicated | 4003 | |
| fake-bank | 4004 | |
| Postgres | assigned by Aspire | random high port bound to 127.0.0.1 |
| Aspire dashboard A | 17002 / 15230, OTLP 19071, resource 20005 | template defaults |
| Aspire dashboard B | 17012 / 15240, OTLP 19081, resource 20015 | **must be edited in B's `apphost.run.json`** or the two AppHosts collide |

### 8.2 Environment variable contract

Invent no others without adding them here.

| Variable | Who reads it | Values |
|---|---|---|
| `NODE_ENV` | all | `development` \| `production` |
| `PORT` | all servers | from Aspire |
| `DEPLOYMENT_MODE` | store | `pooled` \| `dedicated` |
| `TENANT_SLUG` | store, storefront, dashboard | dedicated only |
| `DATABASE_URL` | store, platform | **app role**, `NOBYPASSRLS` |
| `DATABASE_ADMIN_URL` | migrate step only | owner role |
| `AUTH_ADAPTER` | all servers | `stub` \| `oidc` |
| `AUTH_STUB_SECRET` | all servers | dev secret |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_JWKS_CACHE_PATH` | Identity phase | |
| `PLATFORM_URL` | store, admin | |
| `STORE_API_URL` / `VITE_STORE_API_URL` / `NEXT_PUBLIC_STORE_API_URL` | dashboard, storefront | |
| `FAKE_BANK_URL` | platform | |
| `FAKE_BANK_HMAC_SECRET` | platform, fake-bank | shared, control plane only |
| `MERCATUS_ALLOW_FAKE_BANK` | fake-bank | `1` to start at all |
| `INSTANCE_TOKEN` | store, dedicated | per-instance credential (`CE1`) |
| `LICENCE_POLL_SECONDS` | store | default `10` |
| `LICENCE_GRACE_SECONDS` | store | default `259200`; `60` in the demo |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | all | set by Aspire, read with zero config |

Every one of these is parsed once, through a Zod schema, in
`packages/core/src/config.ts`. A missing or malformed variable fails at boot with the name of the
variable, never at the first request.

### 8.3 AppHost A — `aspire/control-plane/apphost.cs`

Single-file C# AppHost (`#:sdk Aspire.AppHost.Sdk@13.5.4`) — Aspire 13 has no `.csproj` for this.
Create it with:

```bash
aspire new aspire-empty --name ControlPlane --output aspire/control-plane \
  --language csharp --non-interactive --nologo --suppress-agent-init
```

Resources: `db-platform` + `db-pooled` (`AddPostgres`), `platform`, `fake-bank`, `store-pooled`
(`DEPLOYMENT_MODE=pooled`), `storefront`, `dashboard`, `admin`, and the two migrate/seed steps as
`WithExplicitStart` executables. Node resources use **`Aspire.Hosting.JavaScript@13.5.4`**:
`AddJavaScriptApp(name, appDirectory, runScriptName)` for Fastify apps,
`AddViteApp(...)` for dashboard/admin, `AddNextJsApp(...)` for the storefront.

### 8.4 AppHost B — `aspire/acme-vps/apphost.cs`

"Zenith's VPS". Binds to A only through `AddExternalService` — it **cannot** reference A's
databases, because they are not in its model, which is what makes `CO3` a property of the tool
rather than a convention.

```csharp
var controlPlane = builder.AddExternalService("control-plane", "http://localhost:4001");
var identity     = builder.AddExternalService("identity",      "http://localhost:4001");
var db           = builder.AddPostgres("db-zenith").AddDatabase("store");
```

plus `store-zenith` (`DEPLOYMENT_MODE=dedicated`, `TENANT_SLUG=zenith`, `INSTANCE_TOKEN`),
its storefront (3002) and its dashboard (5175). Edit `apphost.run.json` per §8.1 before first run.

### 8.5 Running and stopping — non-negotiable

```bash
cd aspire/control-plane && aspire run --detach --non-interactive --nologo --format Json
# ... poll health endpoints ...
cd aspire/control-plane && aspire stop --non-interactive --nologo
```

`aspire run` without `--detach` **blocks forever**. `aspire stop` takes the containers down with
it; verify with `docker ps` and leave the machine as you found it.

---

## 9. Tests

Vitest everywhere. Testcontainers is **not** required — Aspire already gives a Postgres, and a
plain `docker run postgres:18.3` is faster for the leak suite. Use whichever is already up.

**`packages/db-store/test/leak.test.ts` is the one test that must exist before anything is built
on top of the schema** (`BL1`). Every fixture seeds tenant `acme` and tenant `borg`, and for
**every** RLS-protected table it asserts, as `mercatus_app`:

1. inside `withTenantTx` for `acme`, a `select` returns only acme rows
2. an `insert` carrying borg's `tenant_id` is rejected by `with check`
3. an `update` / `delete` of a borg row inside acme's transaction affects **0 rows**
4. a `select` with **no** tenant context returns **0 rows** and does not throw
5. `mercatus_app` does not have `BYPASSRLS`

Plus a grep assertion that no file under `apps/store/src` contains `tenant_id` in a `where`
clause (§3.5), with `packages/db-store/src/tenants.ts` the single allowed exception.

Other tests worth their cost, and no others:
`order number is per-tenant and gapless`, `checkout rejects insufficient stock`,
`passive licence returns 402 and the dashboard still answers 200`,
`store keeps serving with the control plane stopped` (`CO1`).

---

## 10. Task sequence

Each task is one agent, ends with a **gate that executes something**, a `diary/` entry, a
`lessons/` entry, and a commit. Tasks 01–10 are the overnight build; 11 and 12 are stretch.

| # | Task | Gate — the command, not the claim |
|---|---|---|
| **01** | Workspace skeleton: root `package.json`, `pnpm-workspace.yaml` + catalog, `turbo.json`, `tsconfig.base.json`, flat ESLint config, empty `@mercatus/core` and `@mercatus/contracts` | `pnpm install && pnpm turbo run typecheck lint` exits 0 |
| **02** | `@mercatus/db-store`: schema, roles, RLS, migrations, 2-tenant seed, **leak suite** | `pnpm --filter @mercatus/db-store migrate && pnpm --filter @mercatus/db-store test` — leak suite green against a real Postgres |
| **03** | `@mercatus/core`: config, errors, ALS tenant context, tenant resolution, auth types, stub adapter, Fastify plugin, `createServer`. `apps/store` staff products CRUD | `curl` a product in as acme, `curl` the list as borg, get `{"items":[],"total":0}` |
| **04** | `apps/storefront` read path: catalog + product page, tokens.css, `@mercatus/ui` first components | `curl -s localhost:3001/t/acme \| grep` a seeded product title |
| **05** | Basket, checkout, orders: `order_counters`, stock decrement, `/api/orders` | two checkouts on acme give numbers 1 and 2; borg's first is also **1** |
| **06** | `apps/dashboard` SPA: products, orders, settings, stub login | the SPA serves on 5173 and a product created in it appears via `curl /api/products` |
| **07** | `@mercatus/db-platform`, `apps/platform`, `apps/fake-bank`, buy-a-store | `POST /signup` → complete the payment in fake-bank → `GET /tenants/:slug` shows `active` |
| **08** | `apps/admin` console + licence flip + passive behaviour | flip to passive, `POST /t/:slug/checkout` returns **402**, `GET /api/products` still returns **200** |
| **09** | AppHost A — the whole control plane and pooled store under one `aspire run --detach` | `aspire run --detach`, poll all `/health` endpoints 200, `aspire stop`, `docker ps` clean |
| **10** | AppHost B — dedicated `zenith`: register, poll the licence, heartbeat, degrade | with B up, checkout works; `aspire stop` on A; checkout **still works**; after `LICENCE_GRACE_SECONDS=60`, checkout returns 503 and browsing still returns 200 |
| 11 | *stretch* — Traefik on 8090, `*.localtest.me` hostnames | `curl -H 'Host: acme.localtest.me' localhost:8090` reaches the right store |
| 12 | *stretch* — Identity phase: Logto container, `oidc-adapter`, real phone OTP | a staff member signs in through Logto and the dedicated store verifies the token with the control plane stopped |

**Do not start a task whose predecessor's gate did not actually run.** A red gate is a fine thing
to hand over — a gate that was never executed is not.

---

## 11. Standing decisions, restated

Relitigating these costs the build more than getting them slightly wrong does.

- Node 22, TypeScript **strict**, ESM, run with `tsx`. Not native type stripping.
- pnpm workspaces + Turborepo. Versions pinned once, in the catalog.
- Fastify. Zod. Drizzle. No Nest, no Prisma.
- **No job queue, no Redis, no broker.** State derived from timestamps (`AM1`); add pg-boss the
  first time something must *happen* that cannot be derived (`AM2`), which the POC never needs.
- Plain CSS with design tokens and one small shared component set. No Fluent UI, no Tailwind.
- dashboard and admin: Vite + React + TanStack Router **SPA**, not TanStack Start.
- storefront: Next.js App Router.
- Auth behind the adapter from day one; the stub is expected until the Identity phase.
- Never port 3000. Traefik on **8090**.
- `aspire run` is always `--detach`, and always stopped.
- Backward compatibility is not a requirement **inside** the data plane; the control-plane
  contract keeps a compatibility window (`CH1`).
- Versioning is not semver: features bump the first number, bug fixes the second, the third is
  always 0.

---

*Written by task 00. Corrections go in `decisions-made-overnight.md` and `lessons/`, not by
rewriting this file's history — but if a section here is wrong, fix it and say so in your diary.*
