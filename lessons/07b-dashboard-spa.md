# 07b — a Vite SPA against this store API

## The one that cost the most: @fastify/cors 11 blocks PATCH and DELETE

- `@fastify/cors@11.3.0` defaults to **`methods: 'GET,HEAD,POST'`**
  (`node_modules/.pnpm/@fastify+cors@11.3.0/node_modules/@fastify/cors/index.js:11`). Earlier
  majors defaulted to the full set, so every guide you remember is wrong here.
- `packages/core/src/http/server.ts` registered it with `{ origin: true, credentials: true }` and
  nothing else, so **every browser PATCH and DELETE against any service in this repo was dead**.
- The symptom is not an error. The store log shows the preflight and then nothing:

  ```
  "method":"OPTIONS","url":"/api/products/<id>"  -> 204
  (no PATCH line at all)
  ```

  In the browser it is a silent no-op: the mutation never resolves and the page does not navigate.
- Diagnose it in one command, without a browser:

  ```bash
  curl -si -X OPTIONS http://127.0.0.1:4002/api/products/x \
    -H 'Origin: http://127.0.0.1:5173' -H 'Access-Control-Request-Method: PATCH' | grep -i allow-methods
  # access-control-allow-methods: GET,HEAD,POST      <-- before
  ```
- Fixed in `packages/core` with an explicit `methods: ['GET','HEAD','POST','PATCH','PUT','DELETE','OPTIONS']`.
  If you are on admin or storefront, you already have the fix; do not re-debug it.

## @mercatus/contracts cannot be imported in a browser as it stands

- `contracts` imports `@mercatus/core` for three constants, and `core`'s entry point re-exports
  `http/server.ts` → **fastify, pino, jose, @opentelemetry/sdk-node**. Bundling that for a browser
  is not going to happen.
- The fix is four lines and keeps the contracts as the single definition of every wire shape:

  ```ts
  // vite.config.ts
  resolve: { alias: { '@mercatus/core': fileURLToPath(new URL('./src/vendor/core-browser.ts', import.meta.url)) } }
  // src/vendor/core-browser.ts
  export { ERROR_CODES } from '../../../../packages/core/src/errors.js';
  export { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../../../../packages/core/src/paging.js';
  ```
- A Vite `resolve.alias` bypasses the package `exports` map, which is what makes this possible —
  `@mercatus/contracts` exports `"."` only, so a deep import of `src/store.ts` is refused.
- `tsc` still resolves the real `@mercatus/core`, so types stay honest. Typecheck and build both
  pass with the alias in place.

## Versions that work together (installed 2026-09-22)

- vite **8.3.0** + @vitejs/plugin-react **6.1.1** + react **19.3.0** + @tanstack/react-router
  **1.170.38** + @tanstack/router-plugin **1.168.40** + @tanstack/react-query **5.103.2**. No peer
  warnings, no overrides.
- The plugin's vite entry exports **`tanstackRouter`** (not `TanStackRouterVite`, which is the old
  name and still exported):
  `import { tanstackRouter } from '@tanstack/router-plugin/vite'` — and it must come **before**
  `react()`.
- `pnpm install` needed **no new `allowBuilds` entries**: `esbuild` was already approved. It did
  add `@tanstack/query-core` and `@tanstack/react-query` to `minimumReleaseAgeExclude` by itself.
- `src/routeTree.gen.ts` is written by the plugin on dev/build. **Commit it** — `turbo run
  typecheck` runs `tsc` with no Vite in sight and fails on a clean checkout otherwise.
- `vite build` of this app: 272 modules, ~190ms. `tsc --noEmit` over it: ~3s.

## Running the store API without Aspire (30 seconds, no port fights)

Three agents were building front ends at once; `aspire run` binds 4001/4002/4004/8080 and the
dashboard ports, so a private stack is both faster and politer:

```bash
docker run -d --name mercatus-dash-gate-pg -e POSTGRES_PASSWORD=mercatusdevpassword \
  -e POSTGRES_DB=store -p 55432:5432 postgres:18.3
DATABASE_SUPERUSER_URL=postgres://postgres:mercatusdevpassword@127.0.0.1:55432/store \
DATABASE_ADMIN_URL=postgres://mercatus_owner:mercatus_owner_dev@127.0.0.1:55432/store \
  pnpm --filter @mercatus/db-store migrate --seed        # roles, drizzle, RLS, acme + borg
cd apps/store && PORT=4002 HOST=127.0.0.1 DEPLOYMENT_MODE=pooled \
  DATABASE_URL=postgres://mercatus_app:mercatus_app_dev@127.0.0.1:55432/store \
  AUTH_ADAPTER=stub AUTH_STUB_SECRET=mercatus-dev-auth-stub-secret-0123456789 \
  node --import tsx src/index.ts
```

- `migrate --seed` does roles → drizzle-kit → RLS → seed in one step; there is no separate seed run.
- The role passwords are in `packages/db-*/sql/00-roles.sql` and repeated in `aspire/AppHostA/apphost.cs`.
- `AUTH_STUB_SECRET` must be **≥ 32 characters** or the store refuses to boot (jose, HS256).
- Skip the `--import ../../packages/core/src/telemetry.ts` preload when there is no AppHost: the
  OTLP exporter has nothing to talk to.
- A staff token is one POST and lasts 15 minutes:
  `curl -X POST :4002/dev/login/staff -H 'content-type: application/json' -d '{"slug":"acme","role":"owner"}'`.
- **Check the log before you kill it.** A store API on 4002 is a shared resource on this machine:
  another agent found mine and was serving its storefront gate off it within minutes
  (`/t/acme/branding`, `POST /t/acme/checkout` from requests I did not make). `grep '"msg":"incoming
  request"' <log> | tail` before tearing anything down.

## Driving a browser for the gate, with no download

- Playwright's browsers are **already cached on this machine**:
  `~/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome`. Do not run `npx playwright install`.
- `npm i playwright-core` in a scratch directory adds **one** package, then:

  ```js
  chromium.launch({ executablePath: '/home/kappa/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
                    headless: true, args: ['--no-sandbox'] })
  ```
- Keep the gate honest with `page.on('console')` + `page.on('pageerror')` and a non-zero exit when
  either fired. That is what turned up the two findings below.
- `page.on('response')` does **not** report the browser's own `/favicon.ico` fetch; the console
  listener does. An `index.html` with no `<link rel="icon">` therefore costs you two "404 (Not
  Found)" console errors that nothing in the network log explains. An inline
  `data:image/svg+xml,...` icon ends it with no second file.
- Vite's dep re-optimisation shows up as one `REQFAIL ... /node_modules/.vite/deps/zod.js
  net::ERR_ABORTED` and a page reload on the first run after a dependency changes. Harmless.

## TanStack Query key prefixes bite on delete

- `invalidateQueries({ queryKey: ['products'] })` also matches `['products', id]`, so deleting a
  product immediately refetched the detail query and logged a 404 for a row that had just been
  removed.
- Keys are now `['products','list']` and `['products','detail',id]`, and delete does
  `removeQueries` on the detail before invalidating the list.

## Small things

- `vite.config.ts` reading `Number(process.env['PORT'] ?? 5173)` with `strictPort: true` is what
  lets Aspire hand the dedicated copy 5175 with no second config (`CC1`).
- The store has **no `PATCH /api/settings`** — `tenants` carries no RLS policy, so the app role is
  SELECT-only on it. A settings page that writes is not a missing feature, it is the wrong app.
- `typescript-eslint` recommended bans `!`, so `document.getElementById('root')!` fails
  `--max-warnings 0`. Throw on null instead.
- `noUncheckedIndexedAccess` makes `import.meta.env.VITE_X` a `string | undefined` — bracket
  access plus a default (`import.meta.env['VITE_STORE_API_URL'] ?? 'http://localhost:4002'`).
- Money is minor units on the wire everywhere. The form converts once
  (`Math.round(Number(price) * 100)`), and `Intl.NumberFormat` renders it.
