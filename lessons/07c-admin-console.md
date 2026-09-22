# 07c — a Vite + React SPA in this workspace

## `@mercatus/ui` exports its CSS through `exports`, and that is how you get the tokens

```json
"exports": { ".": "./src/index.ts", "./tokens.css": "./src/tokens.css", "./reset.css": "./src/reset.css" }
```

- `import '@mercatus/ui/tokens.css'` from a Vite app then just works: no `?raw`, no alias, no
  PostCSS config. Declare `"@mercatus/ui": "workspace:*"` and `pnpm install` (340ms, 7 packages).
- **Import order matters**: tokens first, then the reset — the reset's `body` rule reads
  `var(--mc-bg)` and `var(--mc-font-sans)`.
- The shared reset does NOT set `html, body, #root { height: 100% }`, reset heading margins, or
  style `a`. An app wanting a full-height shell adds those itself.
- Before switching a local copy out for the shared one, diff the NAMES rather than trusting them:
  `grep -oh -- '--mc-[a-z0-9-]*' app.css | sort -u` against
  `grep -oh -- '--mc-[a-z0-9-]*:' ../../packages/ui/src/tokens.css | tr -d ':' | sort -u`, then
  `comm -23`. Empty output means nothing is undefined.

## `@mercatus/contracts` cannot be imported from a browser app

- `packages/contracts/src/common.ts` imports `DEFAULT_PAGE_LIMIT` / `MAX_PAGE_LIMIT` from
  `@mercatus/core`, whose barrel re-exports `./http/server.js`, which imports **fastify**. Any
  front end importing one Zod schema therefore drags Fastify, `node:async_hooks` and
  `node:http` into the bundle.
- The one-line fix nobody could make tonight (three agents in the tree): move those two constants
  into `packages/contracts` itself, or give core a `./constants` export and import that.
- Until then: `apps/admin/src/api/schemas.ts` restates the four shapes it needs, in Zod, and
  **parses** rather than casts. ~70 lines. Same trap waits for `dashboard` and `storefront`.

## Versions in the catalog, as they actually behaved

- react 19.3.0 / react-dom 19.3.0 / vite 8.3.0 / @vitejs/plugin-react 6.1.1 /
  @tanstack/react-router 1.170.38 / @tanstack/react-query 5.103.2 — installed and ran with no
  peer complaints. `pnpm install` added 19 packages in 2.6s; no build-script gate this time
  (nothing new in `allowBuilds`).
- **`@tanstack/router-plugin` is catalogued at 1.168.40 against a router at 1.170.38.** Not tried:
  five routes are cheaper written as `createRootRoute` / `createRoute` / `createRouter` than as a
  generated `routeTree.gen.ts` that lint and typecheck then need told about. Code-based routing
  needs no plugin, no `routesDirectory`, and no `.gitignore` entry.
- `vite build` of the whole console: 257 modules, 432 kB / 133 kB gzip, 170ms. `vite` dev server
  ready in 134ms.
- Adding a workspace dependency to a RUNNING dev server is fine: vite logs
  `Re-optimizing dependencies because lockfile has changed` on the next request. Restarting it is
  not required, though this task did anyway.

## tsconfig: what the base config is missing for a React app

`tsconfig.base.json` is `lib: ["ES2023"]`, `types: ["node"]`, no `jsx`. A front-end package needs
exactly this and nothing else:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["node", "vite/client"],
    "jsx": "react-jsx"
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "vite.config.ts"]
}
```

- Put `vite.config.ts` in `include` or `tsc --noEmit` never checks it.
- `verbatimModuleSyntax` + `consistent-type-imports` means **`import type { ReactNode } from
  'react'`** everywhere; a value import of a type is an ESLint error, not a warning.
- Relative imports still need the `.js` extension under `moduleResolution: "bundler"` — including
  `.tsx` files, which you write as `../ui/index.js`. Vite resolves it.

## ESLint 10 flat config already covers `.tsx`

- The root `eslint.config.js` has `files: ['**/*.ts', '**/*.tsx']` and needed **no change**.
  `eslint . --max-warnings 0` from `apps/admin` found the root config by ancestor search and
  passed first try.
- `no-undef` is off for TS files (typescript-eslint's `eslintRecommended` turns it off), so
  `window`, `document`, `fetch` and `localStorage` need no `globals` block.
- No react plugin is in the catalog. Nothing missed it; the hooks rules would have caught nothing
  here.

## `readSession()` in the shell renders once and then lies

- The root component read the session with a plain function call. Signing in navigated to
  `/tenants` and the page rendered — but the header still said "not signed in" and the nav links
  never appeared, because nothing told the root component to re-render. It looks exactly like a
  routing bug and is not one.
- Fix: a module-level store + `useSyncExternalStore(subscribe, readSession, readSession)`.
- **Cache the snapshot.** `useSyncExternalStore` compares snapshots by identity, so re-parsing
  the localStorage JSON on every call returns a fresh object each render and React loops forever
  ("The result of getSnapshot should be cached"). One `let cached` invalidated on write/clear.

## Driving the gate

- `vite` with no `--host` binds `localhost`; `--host 127.0.0.1` + `strictPort: true` in
  `vite.config.ts` is what makes 5174 mean 5174. Without `strictPort` Vite silently takes 5175 —
  which is the *dedicated dashboard's* port in §8.1, so the screenshot would be of the wrong app.
- The platform API's CORS is `origin: true, credentials: true` from `createServer()`, so a browser
  on 5174 reaches 4001 with nothing to configure.
- A standalone control plane for a front-end gate is four commands and ~40s; `aspire run` is not
  needed and two agents starting AppHost A at once would collide:

  ```bash
  docker run -d --name <own-name> -e POSTGRES_PASSWORD=… -p 127.0.0.1:<own-port>:5432 postgres:18.3
  docker exec <ctr> psql -U postgres -c "create database platform"
  DATABASE_SUPERUSER_URL=… PLATFORM_DATABASE_ADMIN_URL=… pnpm --filter @mercatus/db-platform migrate --seed
  cd apps/platform && DATABASE_URL=… … ../../node_modules/.bin/tsx src/index.ts
  ```

  Pick your own container name and host port — another agent is doing the same thing tonight.
- `/installations` is empty until a box registers. Two curls fill it, using the fixed dev token
  from `seed-dedicated.ts`:
  `POST /installations/register {"bootstrapToken":"mercatus-dev-bootstrap-token-for-zenith-001","version":"1.0.0"}`
  → take `instanceToken` → `POST /telemetry/heartbeat` with it (204). The bootstrap token is
  **burned**, so re-running the gate from a fresh database is the only way to do it twice.
- `pnpm --filter @mercatus/platform start` hides boot failures (lesson 04b). Run
  `../../node_modules/.bin/tsx src/index.ts` from the app directory instead — same for
  `node_modules/.bin/vite`.

## Driving the console in Chrome

- `computer left_click` with a `ref` from `find` **silently did nothing** on the flip button —
  no error, no request in the platform log, page unchanged. Clicking the same button by
  `coordinate` from a fresh screenshot worked every time. Verify a click by its EFFECT (the
  server log, not the screenshot) before believing it landed.
- A click fired 2s after `navigate` can land while the route is still rendering `Loading...`, so
  it hits nothing. Screenshot first, then click at a coordinate that screenshot shows.

## Small things

- `apps/admin` declares **no `test` script**. An app with the script and no test files fails
  `pnpm -r test` with `No test files found` (lesson 03), and there is nothing here worth a unit
  test that the browser gate does not cover better.
- `import.meta.env.VITE_PLATFORM_URL` is `any` under `vite/client`. A four-line `src/env.d.ts`
  declaring `ImportMetaEnv` makes a typo'd variable a typecheck failure instead of `undefined` at
  the first request.
- Vite only exposes `VITE_`-prefixed variables to the browser, so §8.2's `PLATFORM_URL` is read as
  `VITE_PLATFORM_URL`, defaulting to `http://127.0.0.1:4001`.
