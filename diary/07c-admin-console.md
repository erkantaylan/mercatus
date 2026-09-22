# 07c — apps/admin, the platform console

## What exists now

`apps/admin` — a Vite + React + TanStack Router SPA on **5174**, talking to `apps/platform` on
4001. Nothing outside `apps/admin/` was touched, except this diary entry, the lessons file,
`docs/decisions-made-overnight.md` and `diary/screenshots/`.

```
apps/admin/
  index.html  vite.config.ts  tsconfig.json  package.json
  src/main.tsx                      QueryClientProvider + RouterProvider
  src/router.tsx                    the route tree, written in code (no router-plugin)
  src/env.d.ts                      VITE_PLATFORM_URL
  src/api/schemas.ts                Zod shapes for what the control plane returns
  src/api/client.ts                 one request(), bearer + error envelope + parse
  src/auth/session.ts               operator token, an external store + useSession()
  src/routes/root.tsx               shell: nav, operator, sign out
  src/routes/login.tsx              stub operator login
  src/routes/tenants.index.tsx      slug, tier, status, licence, heartbeat
  src/routes/tenants.detail.tsx     licence + installation + the active/passive flip
  src/routes/installations.index.tsx  version, last seen, counts, registered
  src/ui/index.tsx                  PageHeader, Card, Banner, Button, EmptyState, StatusPill
  src/ui/format.ts                  formatInstant, formatAge
  src/styles/app.css                plain CSS; @mercatus/ui supplies tokens + reset
```

Routes: `/` redirects to `/tenants` (or `/login`), `/login`, `/tenants`, `/tenants/$slug`,
`/installations`. `beforeLoad` sends an unauthenticated visitor to `/login`; the control plane is
what actually refuses a request.

What the brief asked for, and where it is:

| | |
|---|---|
| list tenants with status | `/tenants` — status **and** licence status, as separate columns |
| activate/deactivate | `/tenants/$slug` → `POST /tenants/:slug/licence` |
| dedicated installations with version + last-seen | `/installations`, and on each tenant's detail |
| a tenant's licence | the Licence card: status, valid-until, entitlements, activated |

`/installations` create-a-bootstrap-token and `/payments` from BUILD-PLAN §7.4 are **not** built —
see the lessons file and the decisions entry.

## The gate — what was actually run

Not `aspire run`; a hand-built control plane, because the console only needs the platform API.

```bash
docker run -d --name mercatus-admin-pg -e POSTGRES_PASSWORD=mercatus_dev_superuser \
  -p 127.0.0.1:55433:5432 postgres:18.3
docker exec mercatus-admin-pg psql -U postgres -c "create database platform"

export DATABASE_SUPERUSER_URL="postgres://postgres:mercatus_dev_superuser@127.0.0.1:55433/platform"
export PLATFORM_DATABASE_ADMIN_URL="postgres://mercatus_platform_owner:mercatus_platform_owner_dev@127.0.0.1:55433/platform"
pnpm --filter @mercatus/db-platform migrate --seed
pnpm --filter @mercatus/db-platform seed:dedicated

cd apps/platform && DATABASE_URL="postgres://mercatus_platform_app:mercatus_platform_app_dev@127.0.0.1:55433/platform" \
  AUTH_ADAPTER=stub AUTH_STUB_SECRET="mercatus-dev-stub-secret-000000000000" \
  FAKE_BANK_HMAC_SECRET="mercatus-dev-fake-bank-secret-0000000" PORT=4001 HOST=127.0.0.1 \
  ../../node_modules/.bin/tsx src/index.ts &

# give the console something to list on /installations
curl -X POST :4001/installations/register -d '{"bootstrapToken":"mercatus-dev-bootstrap-token-for-zenith-001","version":"1.0.0"}'
curl -X POST :4001/telemetry/heartbeat -H "authorization: Bearer <instanceToken>" \
  -d '{"version":"1.0.0","tenantId":"<zenith>","licenceId":null,"productCount":4,"orderCount":2}'   # 204

cd apps/admin && ./node_modules/.bin/vite --host 127.0.0.1                                          # 5174
```

Then, in Chrome:

1. `http://127.0.0.1:5174/` → redirected to `/login`; signed in as `dev-operator`.
2. `/tenants` listed three: **zenith** (dedicated, active, `1.0.0 · 6m ago`), **acme**, **borg**
   (pooled, active, "pooled — we measure it").
3. `/installations` listed zenith: version `1.0.0`, last seen, 4 products, 2 orders, registered at.
4. `/tenants/acme` → **Suspend (passive)** → pill, licence and banner all flipped; `/tenants`
   showed acme `passive`.
5. **Restore (active)** → back to active.

Verified against the API rather than only on screen:

```
GET /tenants/acme  after suspend → "status":"passive","licence":{"status":"passive"…}
GET /tenants/acme  after restore → "status":"active","licence":{"status":"active"…}
platform.log       acme -> passive by operator dev-operator
                   acme -> active  by operator dev-operator      (BH2)
```

`turbo run typecheck lint build --filter=@mercatus/admin` → 4 successful (it pulls
`@mercatus/ui`'s typecheck and lint in as dependencies). Browser console: clean.

The whole sequence was run **twice**: once on the app's own copy of the tokens, then again after
switching to `@mercatus/ui/tokens.css` (below), so the committed screenshots match the committed
code. Four flips are in the log, two per pass.

Evidence: `diary/screenshots/07c-tenant-passive.jpg`,
`diary/screenshots/07c-tenants-list-passive.jpg`,
`diary/screenshots/07c-tenant-restored-active.jpg`,
`diary/screenshots/07c-installations.jpg`.

## What the next agent needs to know

- **The machine was left as found.** The Postgres container was removed, both processes killed,
  `docker ps` back to just `chess-trainer`. Nothing of this gate survives except the code.
- **The console consumes `@mercatus/ui/tokens.css` and `@mercatus/ui/reset.css`.** Those landed
  from a concurrent agent partway through this task; the local copies this app started with were
  deleted and `main.tsx` now imports the shared ones. Every `--mc-*` name the console uses is
  defined there — checked with a `comm` of the two lists, no misses. `src/styles/app.css` is the
  console's own layout and is not shared.
- **`apps/admin` does not depend on `@mercatus/contracts`**, and neither should any other browser
  app until `packages/core`'s barrel stops re-exporting `http/server.js`. Details in the lessons
  file; it is a one-line fix in `packages/core/src/index.ts` that nobody could make tonight
  without clobbering another agent.
- **Task 04a's `apps/platform/src/schemas.ts` still has not been moved into
  `packages/contracts`.** Its header asks the console's task to do it. Same reason as above: three
  agents were in the tree. `installationSchema` and `installationListSchema` are the two shapes
  that want moving.
- **`POST /installations` (issue a bootstrap token) has no screen.** The API is there and task 10
  exercises it by hand; adding the screen is maybe forty lines once somebody wants it.
- **There is no `payments` screen** — `apps/platform` has no `GET /payments` to list, only
  `POST /payments/callback`. Building the screen means building the endpoint first, which is
  outside `apps/admin`.
- **The admin has no test script**, so `pnpm -r test` and `turbo run test` skip it. That is
  deliberate per lesson 03 ("an app with a `test` script and no test files fails the run"), not an
  oversight. Its gate is the browser.
- **`pnpm-lock.yaml` and `pnpm-workspace.yaml` are deliberately NOT in this commit.** Both were
  already modified by the two agents working alongside this one; committing them would have swept
  `apps/dashboard` and `apps/storefront` importer entries into a commit that does not contain
  those packages. `apps/admin`'s own entry is therefore missing from the committed lock — a plain
  `pnpm install` puts it back, and whoever commits the lock last will carry all three.
- **This commit depends on files another agent had not committed yet.**
  `packages/ui/src/tokens.css` and `reset.css`, and the `./tokens.css` / `./reset.css` entries in
  `packages/ui/package.json`, were on disk but uncommitted when `apps/admin` landed. The console
  builds and runs against them today; a checkout of commit `b3d2719` **alone** would not build
  until the `@mercatus/ui` commit is also present. Nothing to fix — just do not bisect across this
  pair and conclude the console is broken.
