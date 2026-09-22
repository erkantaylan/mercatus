# 07a — Next 16 in this workspace

## The one that cost an hour: `next dev` renders, and nothing on the page works

- Symptom: every page 200s and looks right, but **no click does anything**. No console error, no
  overlay, no failed request. `Object.keys(el).filter(k => k.startsWith('__react'))` on any
  button returns `[]` — React never hydrated. Waiting 24s does not help.
- `next build && next start` hydrates fine. That is what makes it look like a bundling problem
  and sends you into `transpilePackages`.
- The cause is printed **only in the dev server's own log**, not in the browser:

  ```
  module.exports = { allowedDevOrigins: ['127.0.0.1'] }
  Read more: https://nextjs.org/docs/app/api-reference/config/next-config-js/allowedDevOrigins
  ```

  `next dev` treats `127.0.0.1` as a different origin from `localhost` and refuses the dev-only
  requests hydration waits on. **Everything in this repo is curled and driven at `127.0.0.1`**, so
  the fix is `allowedDevOrigins: ['127.0.0.1']` in `next.config.ts`. Already there.
- Read `tail` of the dev server log before believing anything the browser tells you.

## Neither Turbopack nor webpack maps `.js` imports back to `.ts`

- The workspace convention is `export * from './errors.js'` inside a package's TypeScript
  (lesson 01). Importing `@mercatus/contracts` at **runtime** from a Next app gives:

  ```
  The export storeBrandingSchema was not found in module packages/contracts/src/index.ts
  The module has no exports at all.
  ```

- `transpilePackages` does not fix it. `experimental.extensionAlias: { '.js': ['.ts','.tsx','.js'] }`
  is **ignored by Turbopack** and *half*-works under `next dev --webpack`: the page renders, but
  three of the nine schemas still come back as `Attempted import error: 'checkoutResultSchema' is
  not exported`. Do not build on that.
- What the storefront does instead: **`import type` only** from `@mercatus/contracts`. A type
  import is erased before any bundler sees it, needs no resolution, and still fails
  `turbo run typecheck` when the contract moves. The two bodies this app genuinely has to
  validate at runtime (the browser's checkout POST, fake-bank's callback) get a local five-field
  Zod schema each.
- Relative imports **inside** the Next app also may not carry `.js`. Use the `@/` alias:
  `paths: { "@/*": ["./*"] }` in tsconfig, `import { config } from '@/lib/config'`. Both Next
  bundlers and `tsc` resolve that.

## Next 16 odds and ends

- It writes an `AGENTS.md` and a `CLAUDE.md` into the app directory on first start. Turn it off
  with `agentRules: false`.
- `params` is a Promise in every page and route handler: `const { slug } = await params`.
- `--webpack` still exists as a `next dev` / `next build` flag; Turbopack is the default and is
  what this app uses.
- `next build` runs `tsc` itself and reports it as "Running TypeScript".
- CSS imported from a workspace package (`@mercatus/ui/tokens.css`) works with
  `transpilePackages: ['@mercatus/ui']` and an `exports` entry per stylesheet. No `styled-jsx`,
  no CSS modules needed.

## Playwright on this machine

- `~/.cache/ms-playwright` holds **chromium-1208**; `playwright@1.63.0` wants **1243**. Do not
  download it — `chromium.launch({ channel: 'chrome' })` uses `/usr/bin/google-chrome`, which is
  installed, and works headless.
- `NODE_PATH` does not work for ESM. `npm install playwright` into a scratch directory and put
  the `.mjs` script **in that directory**.
- **Playwright will click a server-rendered button before React has hydrated**, and the click
  silently does nothing. Assert on the effect, not on the click: click in a loop until
  `localStorage` actually changed. This is a real race, not a test artifact — it bit the gate
  before `allowedDevOrigins` was even suspected.

## Working against other agents' services

- Two other frontend agents were running. `ss -ltnp | grep :400` before starting anything: a
  store API was already on 4002 and a platform on 4001, and **both vanished mid-gate** when that
  agent tore its stack down.
- `tr '\0' '\n' < /proc/<pid>/environ` is how you find out which `FAKE_BANK_HMAC_SECRET` a
  running platform was started with, so a fake-bank you start on 4004 does not break theirs. The
  one in use was `mercatus-dev-fake-bank-secret-0000000`, **not** the AppHost A literal.
- Own your dependencies for a gate. Self-contained store stack, from nothing, in about 40s:

  ```bash
  docker run -d --name mercatus-sf-gate-pg -e POSTGRES_PASSWORD=devpassword -p 55434:5432 postgres:18.3
  docker exec mercatus-sf-gate-pg psql -U postgres -c "create database store"
  DATABASE_SUPERUSER_URL=postgres://postgres:devpassword@127.0.0.1:55434/store \
  DATABASE_ADMIN_URL=postgres://mercatus_owner:mercatus_owner_dev@127.0.0.1:55434/store \
    pnpm --filter @mercatus/db-store migrate
  DATABASE_ADMIN_URL=... pnpm --filter @mercatus/db-store seed
  ```

## Small things

- `no-useless-assignment` (in `js.configs.recommended`) rejects `let x: T | null = null;` followed
  by an unconditional `try { x = … } catch { x = null }`. Declare it without an initialiser.
- A `data-*` attribute on a status banner (`data-payment="paid"`) is worth adding purely so the
  gate can assert on it without matching prose.
- fake-bank's hosted page has **no return link**. A storefront that redirects to it has to bring
  the shopper back itself: write the order id to `localStorage` before leaving, and check it on
  `pageshow` (not just on mount — a back-navigation can come from the bfcache, which restores the
  DOM without re-running effects).
