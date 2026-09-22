# 11 — Playwright against this stack, and four traps that are not Playwright's

## Playwright 1.63 with no downloaded browser

- `"@playwright/test": 1.63.0` in the catalog, and **`playwright: false` in `allowBuilds:`** —
  its postinstall downloads ~450 MB of browser bundles and pnpm 12 fails the whole install over an
  unanswered build script (lesson 01). Refusing it is the right answer here, not `true`.
- `channel: 'chrome'` then launches **`/usr/bin/google-chrome`** (151.0.7922.108 on this machine)
  with nothing downloaded. Lesson 07a's warning about `chromium-1208` vs the version playwright
  wants does not apply — the channel does not look in `~/.cache/ms-playwright` at all.
- `outputDir` and the HTML reporter's `outputFolder` accept a path outside the package:
  `fileURLToPath(new URL('../../', import.meta.url))` from `packages/e2e` puts `test-results/` and
  `playwright-report/` at the repo root. **Playwright empties `outputDir` at the start of a run**,
  so hand-written screenshots in it are fresh per run rather than accumulating.
- `test.describe.configure({ mode: 'serial' })` does **not** share a browser context between
  tests. Each test gets a fresh one, and a fresh context is a fresh cookie jar — so "the shopper
  signs in once" quietly became "signs in three times". Create the context in `beforeAll`
  (`browser.newContext()`), keep `page` in a module variable, close it in `afterAll`.

## `accept: application/json` gets a 404 out of a healthy Vite dev server

```
curl -H 'accept: application/json' 127.0.0.1:5173/   -> 404
curl -H 'accept: */*'              127.0.0.1:5173/   -> 200
```

- Vite's SPA history fallback only rewrites `/` to `index.html` for a request that accepts
  `text/html`. A readiness probe that sets a JSON accept header therefore waits out its entire
  timeout against a stack that is up, and then blames the wrong resource.

## `path=` in zsh destroys your PATH

- A poll loop with `path=/health` inside it died with `command not found: curl`, then
  `command not found: sleep`, then `command not found: date`. **`path` is tied to `PATH` in zsh**
  (as `PATH`'s array form). Name the variable anything else.

## A `*/` inside a block comment ends the comment

- Documenting `accept: */*` in a TSDoc block gives
  `SyntaxError: Unexpected token (46:14)` from Playwright's transform, pointing at a line of
  prose. Write it out in words.

## Two `next dev` on one package directory

- Lesson 10 left this untested. It works, given a distDir each: `next.config.ts` reads
  `distDir: process.env['NEXT_DIST_DIR'] ?? '.next'`, AppHost A passes `.next-pooled` and B
  `.next-zenith`. Both storefronts ran together for the whole suite with no interference.
- **Next rewrites `next-env.d.ts` on every start** to `import "./<distDir>/dev/types/routes.d.ts"`,
  so with two instances the committed file flips between the two names and every run leaves a
  diff. It is now gitignored and removed from the index; `tsc --noEmit` in `apps/storefront`
  passes **without** the file (verified by moving it away), and typecheck then stops depending on
  a generated directory existing at all.
- `eslint.config.js` ignores `**/.next/**` and not `.next-pooled`. The storefront's lint went from
  clean to **24,242 problems** in generated output. Add `**/.next-*/**`.

## Killing and relaunching an Aspire-managed process from a test

- `ss -ltnp` → `pid=(\d+)` is the way to find it; `pkill -f` matches the test's own command line
  (lesson 03).
- `/proc/<pid>/cmdline` and `/proc/<pid>/environ` are NUL-separated — `readFileSync(...).split('\0')`.
  **`/proc/<pid>/cwd` is a symlink**, so `readFileSync` on it is `EISDIR`: use `readlinkSync`.
- Capture all three **before** the kill, then `spawn(cmd, args, { cwd, env, detached: true,
  stdio: 'ignore' }).unref()` brings it back byte-identical, random Postgres host port included.
- That process is **not Aspire-managed**, so `aspire stop` leaves it holding port 4001. The suite
  prints its pid and writes `test-results/relaunched-platform.pid`; kill it by hand.
- Timings measured here: platform unreachable within ~2 s of `SIGTERM`; the dedicated store reports
  `state: grace` about 10 s later (one 5-second poll plus the fetch timeout); `healthy` again about
  2 s after the relaunch answers.

## Asserting a React app that may not have hydrated

- Lesson 07a's rule generalises: **put the whole attempt, `page.goto` included, inside
  `expect(...).toPass()`**, and wait for an effect the DOM cannot fake.
  - sign-in → the **session cookie** (`page.context().cookies()`), not any text on the page
  - add to basket → the header's `Basket (n)` link
  - dashboard sign-in → `.mc-brand small` showing the slug
- A form that has not hydrated accepts `fill()` and drops the `click()`, with nothing anywhere
  saying so. Re-navigating on each attempt is what makes the retry meaningful.
- Assert what a page renders only for something the server rendered. `data-payment` on the
  confirmation banner and `data-shopper` in the store header exist for exactly this.

## This stack's own shapes, so you do not have to read for them

- Operator token: `POST :4001/dev/login/operator {"subject":"e2e"}`. Licence flip:
  `POST :4001/tenants/<slug>/licence {"status":"passive"|"active"}` with that bearer.
- Staff token: `POST <store>/dev/login/staff {"slug","role"}`. `GET <store>/api/licence` with it
  gives `{status, state, lastSuccessAt}`; `GET <store>/t/<slug>/branding` gives the shopper's half,
  `licence.checkout` ∈ `open | blocked_passive | blocked_unreachable`.
- The admin console has testids already: `sign-in`, `operator-input`, `tenant-row-<slug>`,
  `tenant-status-<slug>`. The dashboard has none; `#slug`, `.mc-brand small` and `table tbody tr`
  are what there is.
- fake-bank's hosted page: `button[data-behaviour="approve"|"decline"|"bad-hash"|"no-callback"|"drop"]`,
  and `#result` fills with `200 {…"status": "paid"…}`. There is no return link — `page.goBack()`
  to the checkout page, whose `pageshow` handler redirects to the confirmation.
- **Order numbers are the assertions** (`BG2`), so the suite cannot run twice against one database.
  Both story specs check "zero orders so far" in `beforeAll` and fail with a sentence naming the
  `aspire run` to redo. Do that rather than relaxing the assertion — "acme's first is 1 and borg's
  first is also 1" is the visible half of the rule.

## Timings, this machine

- AppHost A from `aspire run --detach` to all seven surfaces answering: **~26 s** (traefik last,
  ~10 s after the rest). AppHost B: **~19 s**, provisioning included.
- The whole suite: **40 s**, 16 tests, one worker, real Chrome, headless.
