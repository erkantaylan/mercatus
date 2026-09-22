# 11 — Playwright end to end, driving real Chrome

Status: **done**. `pnpm test:e2e` is **16 passed (39.7s)** against a freshly started stack — both
AppHosts, torn down and brought back up first, so the number is not a replay. Twenty-three
screenshots are in `test-results/`.

## What exists now

### `packages/e2e` — the suite (new)

`@mercatus/e2e`, one Playwright project, one worker, no retries, serial. `pnpm test:e2e` at the
repo root runs it. It is **not** a turbo task: it needs a live topology, it is never cacheable, and
turbo would happily replay a green run against a stack that is no longer up.

| | |
|---|---|
| `playwright.config.ts` | `channel: 'chrome'` — the real `/usr/bin/google-chrome` (151), headless. Output at the REPO ROOT: `test-results/`, `playwright-report/` |
| `tests/helpers/global-setup.ts` | Refuses to run against a stack that is not up, and names the `aspire run` that is missing. AppHost B is optional and its absence is printed, not fatal |
| `tests/helpers/stack.ts` | The topology over HTTP and `/proc`: probes, the operator token, the licence flip, `/api/licence`, and capture/kill/relaunch of the control-plane process |
| `tests/helpers/shop.ts` | The shopper's journey — sign in, add to basket, check out, settle at the bank, come home by browser Back — plus the merchant dashboard's sign-in |
| `tests/01-pooled-two-tenants.spec.ts` | 6 tests: one sign-in, two merchants, and neither merchant able to see the other's order |
| `tests/02-passive-licence.spec.ts` | 5 tests: passive blocks checkout and leaves the dashboard fully usable, writes included |
| `tests/03-dedicated-outage.spec.ts` | 5 tests: the dedicated store sells, the control plane is killed, it keeps selling, it recovers |

Nothing in the suite imports a workspace package. It drives the stack the way an operator does, so
a shared helper that happened to bypass the wire could not quietly make a test pass.

### `apps/storefront` — the shopper actually signs in now

The acceptance criteria opens with *"a shopper signs in once"*, and until this task the only way a
shopper session came into being was a checkout: the form asked for a phone, the route handler
minted a token per checkout and wrote the cookie. That is a guest checkout twice, not one account.

- `app/signin/page.tsx` + `components/SignInForm.tsx` — one sign-in page for the whole storefront,
  deliberately **not** under `/t/[slug]`: the session is tenant-less (Q20), so putting it inside a
  store's shell would suggest an account "at acme" when what there is, is an account.
- `app/api/session/route.ts` — `POST` mints and sets the cookies, `DELETE` clears them.
- `lib/session.ts` — beside the httpOnly bearer cookie there are now two readable ones, phone and
  name. They are not credentials; they are what the header shows and what goes on the order as
  contact detail, and they let a server component say "buying as +90…" without a key to decode a
  JWT with.
- `app/api/checkout/route.ts` — **the session comes first**. A signed-in shopper posts no identity
  at all and the existing token is reused; a posted phone still signs a guest in on the spot.
- The store shell's header shows the signed-in phone (`data-shopper`), and the checkout page shows
  "Buying as …" with no phone field.

### `aspire/AppHostA` — the pooled front ends are in the topology

07a–07c built `storefront`, `dashboard` and `admin` and left them out of the application model, so
the demo needed three processes started by hand. They are resources now (3001, 5173, 5174), with
the same `Node`/`Web` helper AppHost B uses. A browser gate against a stack somebody has to
assemble by hand is a gate that does not get run.

### `NEXT_DIST_DIR`

The pooled storefront and the dedicated one are the same package in the same directory, so two
`next dev` processes shared `apps/storefront/.next`. `next.config.ts` now reads
`distDir: process.env['NEXT_DIST_DIR'] ?? '.next'`; A passes `.next-pooled`, B `.next-zenith`.
Lesson 10 flagged this as untested — it is tested now, and both storefronts run together.

## The gate, observed

```
cd aspire/AppHostA && aspire run --detach --non-interactive --nologo --format Json   # healthy in ~26s
cd aspire/AppHostB && aspire run --detach --non-interactive --nologo --format Json   # healthy in ~19s
pnpm test:e2e
```

```
AppHost A and AppHost B are both up. The dedicated-instance spec will run.

Running 16 tests using 1 worker
  ✓  1 a shopper signs in once, for every store on the platform (1.3s)
  ✓  2 buys from pooled tenant acme (2.9s)
  ✓  3 buys from pooled tenant borg with the SAME account, and is not asked to sign in again (1.4s)
  ✓  4 one account, one order at each shop (766ms)
  ✓  5 acme's merchant sees acme's order, and cannot reach borg's (1.9s)
  ✓  6 borg's merchant sees borg's order, and cannot reach acme's (2.4s)
  ✓  7 flipping the licence to passive reaches the store within one poll (404ms)
  ✓  8 the storefront browses and refuses to check out (827ms)
  ✓  9 the store API answers 402 to a checkout and 200 to the catalogue (30ms)
  ✓ 10 the merchant dashboard is fully usable, writes included (2.0s)
  ✓ 11 the platform console shows the tenant as passive (878ms)
  ✓ 12 the same shopper signs in at the dedicated store (1.1s)
  ✓ 13 buys from the dedicated store, control plane up (3.0s)
  ✓ 14 the control plane is stopped (13.1s)
  ✓ 15 the dedicated store still completes a checkout (1.9s)

  control plane relaunched by hand as pid 529279 -- kill it before/after `aspire stop`, it is not Aspire-managed
  ✓ 16 and catches up when the control plane comes back (2.5s)

  16 passed (39.7s)
```

What the sixteen actually assert, in the vocabulary of the rules:

- **One account, two merchants.** One sign-in at `127.0.0.1:3001/signin`; acme's first order is
  **1** and borg's first order is **also 1** (`BG2`, per-tenant gapless counters in one database);
  the shopper's own list is 1 order at each shop (`BI2`, route-tenant **and** token-subject).
- **Neither merchant sees the other.** acme's dashboard has exactly one row, whose lines say
  *Rocket Skates* and not *Ocular Implant*; borg's order id typed into acme's dashboard answers
  **Not found**, not "forbidden" (`BE1`, and `S1` — a 403 would confirm the row exists). Then the
  same, reversed.
- **Passive is not unreachable** (`CG3`). Flipped in the control plane, seen by the store one
  5-second poll later: the storefront still browses and the checkout page refuses; the store API
  answers **402 LICENCE_PASSIVE** to a checkout and **200** to the catalogue; the dashboard reads
  *and* **writes** — a product created and deleted while passive, because `writesRefused` is
  `read_only` only. The console shows `passive` beside the tenant.
- **The flagship.** The dedicated store sells (order 1, paid). The Aspire-managed `platform`
  process is killed with `SIGTERM`; within one poll the store reports `status: active`,
  `state: grace` — never `passive`, because being unreachable is ours (`CG3`). A second checkout
  **completes** with the control plane dark: order **2**, paid, priced and numbered by their own
  database. Browsing, the shopper's own orders and the merchant's dashboard on their own server all
  stay 200. The platform is relaunched from its captured `/proc` environment, and one poll later
  the store is `healthy` again with nothing restarted on their side.

Screenshots, `test-results/01-…png` through `20-…png` plus `bank-*.png`, in the order the demo
happened. `18-zenith-order-during-outage.png` is the money shot: *Order #2, Paid* on Zenith's own
storefront while the control plane was down.

**Repo check:** `pnpm turbo run typecheck lint test` → 33/33, and `--force` on the test task →
`@mercatus/db-store` **88 passed (4 files)**.

## What the next agent needs to know

1. **The suite needs a freshly started stack**, and says so rather than failing arithmetically:
   both story specs assert in `beforeAll` that the relevant tenants have zero orders, with a
   message naming the `aspire run` to redo. Order **1** and order **2** are the assertions; they
   cannot survive a second run against the same database.
2. **The recovery test leaves a control plane that Aspire does not own.** It relaunches the
   platform from `/proc`, detached, so the process outlives the test worker — and `aspire stop`
   will not take it down. Its pid is printed and written to
   `test-results/relaunched-platform.pid`; kill it before or after `aspire stop`, or port 4001
   stays held.
3. **`apps/storefront/next-env.d.ts` is now gitignored and was removed from the index.** Next
   rewrites it on every start to name the current `distDir`, so with two instances it flipped
   between `.next-pooled` and `.next-zenith` and produced a diff after every run. The storefront
   typechecks without it (verified by moving it away and running `tsc --noEmit`) — and it no longer
   makes `turbo run typecheck` depend on a generated directory.
4. **`eslint.config.js` ignores `**/.next-*/**`** as well as `**/.next/**`, or the storefront's lint
   reports 24,000 problems in generated output.
5. Untouched: `docs/OPEN-DEFECTS.md` F1 (composite foreign keys) is still open;
   `packages/contracts/src/common.ts` still imports from `@mercatus/core`, so the dashboard's
   `src/vendor/core-browser.ts` shim is still load-bearing.

## Machine state

Left as found. Both AppHosts stopped from their own directories, the hand-relaunched platform
killed first. `docker ps` shows only `mercatus-dash-gate-pg` (task 07b's leftover on 55432) and
`chess-trainer`, both pre-existing. Every port in §8.1 is free. `.instance/zenith.json` was
deleted for the reason task 10 gives: it holds a credential for a control-plane database that
`aspire stop` destroyed, and leaving it would make B skip registration and poll with a token the
next platform has never seen. `test-results/` and `playwright-report/` are on disk and gitignored.
