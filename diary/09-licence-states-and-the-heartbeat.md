# 09 — licence states and the heartbeat

Status: **done**. The gate ran against the real AppHost A topology, in Chrome, and all four
states of `CG3` were observed on the wire.

## What exists now

### `apps/store/src/agents/licence-poll.ts` — the heartbeat (new)

Every `LICENCE_POLL_SECONDS`, for each tenant this instance serves:

- `GET {platform}/tenants/{slug}/licence` → `recordLicenceSuccess` (status, entitlements,
  validUntil, `last_success_at`)
- a failure → `recordLicenceAttempt`, which touches `last_checked_at` and **deliberately not
  `status`**: unreachable is not passive, and the cached licence keeps serving.
- `POST {platform}/telemetry/heartbeat` — **only when an `INSTANCE_TOKEN` is held**, i.e. only on
  a dedicated instance (CJ1). It reports version, tenant, licence id and two counts (CE6, CI1).

Every arrow is outbound (CE4). Pooled enumerates `tenants` (the one table without RLS); dedicated
resolves its single `TENANT_SLUG`. Ticks skip rather than overlap, the timer is `unref`'d, and a
poll times out at two thirds of the interval.

### `apps/store/src/plugins/licence-gate.ts` — the enforcement (new)

A `preHandler` hook reading `config: { licence: 'checkout' | 'write' }` off the route it is about
to run. Declared on `POST /t/:slug/checkout` and on the three `/api/products` writes.

| state | checkout | staff write | staff read | browse |
|---|---|---|---|---|
| healthy | 201 | 201 | 200 | 200 |
| **passive** | **402 `LICENCE_PASSIVE`** | **201** | 200 | 200 |
| grace | 201 | 201 | 200 | 200 |
| **read_only** | **503 `CONTROL_PLANE_UNREACHABLE`** | **503** | 200 | 200 |

Two codes, never one. A passive tenant keeps every write, because the page that fixes a passive
licence is in the dashboard.

### `apps/store/src/licence.ts`

Lost its `mode === 'pooled'` shortcut — one state machine for both modes now that pooled polls
(CC1). Gained `checkoutBlock()`, `writesRefused()`, `storefrontLicence()` and
`ENTITLEMENT_WHITE_LABEL`.

### The entitlement (CC3)

`GET /t/:slug/branding` now carries `licence: { checkout, poweredByMark }`. The storefront shell
draws the blocked banner from the first and gates the "a store on mercatus" footer mark on the
second. The admin console has an **Entitlements** card with a white-label toggle, so the rule is
demonstrable rather than claimed.

### Control plane

`PLATFORM_INTERNAL_TOKEN` — the pooled plane's licence-poll credential, compared in constant time,
recognised on the licence route only, and never on `/telemetry/heartbeat`. A third principal kind
(`internal`) beside `operator` and `instance`. `licencePollResultSchema` gained `licenceId`.

### Front ends

- storefront: `lib/licence.ts` (two blocked states, two different sentences), a shell banner, and
  the checkout page refuses one screen before the API does.
- dashboard: `useLicence()` is now one shared query key, and `writesRefused` finally does
  something — the product form and Delete grey out in `read_only` and **not** in `passive`.

### AppHost A

`PLATFORM_INTERNAL_TOKEN` on both, `LICENCE_POLL_SECONDS=5`, `LICENCE_GRACE_SECONDS=60`.

## The gate, observed

`aspire run --detach` (AppHost A), plus the storefront on 3001, the dashboard on 5173 and the
console on 5174. Chrome drove the console. One line a second: a shopper's checkout, a staff read,
a staff write, what the store believes, and what a shopper is told.

**Suspend (passive) clicked in the console at 06:39:12 UTC:**

```
06:39:11  checkout=201  dash-read=200  dash-write=201  licence=active/healthy   storefront=open
06:39:17  checkout=201  dash-read=200  dash-write=201  licence=active/healthy   storefront=open
06:39:18  checkout=409  dash-read=200  dash-write=201  licence=active/healthy   storefront=open   <- stock ran out, not the licence
06:39:19  checkout=402  dash-read=200  dash-write=201  licence=passive/passive  storefront=blocked_passive
06:39:35  checkout=402  dash-read=200  dash-write=201  licence=passive/passive  storefront=blocked_passive
```

Seven seconds from click to refusal (one 5 s poll plus the console round trip). `dash-read` and
`dash-write` never moved. `{"error":{"code":"LICENCE_PASSIVE","message":"This store is not
currently taking orders."}}`. **`borg`, the other pooled tenant in the same process and the same
database, checked out 201 throughout.**

**Restore (active) clicked at 06:41:29:**

```
06:41:33  checkout=402  ...  licence=passive/passive  storefront=blocked_passive
06:41:34  checkout=201  ...  licence=active/healthy   storefront=open
```

Five seconds — exactly one poll interval.

**The white-label entitlement, clicked at 06:40:47:**

```
before  branding.licence = {'checkout': 'blocked_passive', 'poweredByMark': True}
06:40:51 poweredByMark=False        (one poll interval later)
storefront /t/acme  ->  "a store on mercatus" occurrences: 1 -> 0
```

No rebuild, no restart, no flag. A row in the control plane (CC3).

**The platform stopped at 06:42:10 (`kill -TERM`), i.e. unreachable rather than passive:**

```
06:42:23  checkout=201  dash-read=200  dash-write=201  licence=active/healthy   storefront=open
06:42:24  checkout=201  dash-read=200  dash-write=201  licence=active/grace     storefront=open
06:43:07  checkout=201  dash-read=200  dash-write=201  licence=active/grace     storefront=open
06:43:08  checkout=503  dash-read=200  dash-write=503  licence=active/read_only storefront=blocked_unreachable
06:43:26  checkout=503  dash-read=200  dash-write=503  licence=active/read_only storefront=blocked_unreachable
```

Healthy for 3 polls, then **44 seconds of grace in which nothing was refused**, then read-only.
`GET /t/acme/products` stayed 200 direct and 200 through Traefik on 8080. The licence **status
stayed `active` the whole time** — being unreachable never becomes being passive.

**Platform restarted at 06:44:16:** `active/read_only` → `active/healthy` and 201 by 06:44:19.

Screenshots: `diary/screenshots/09-storefront-passive-banner.jpg`,
`09-dashboard-passive-fully-usable.jpg`, `09-console-passive-and-entitlements.jpg`.

**Repo check:** `pnpm turbo run typecheck lint test` → **31/31 tasks, exit 0**. 15 new tests
(`apps/store/test/licence.test.ts`, 9, pure; `apps/store/test/licence-gate.test.ts`, 8 against a
real Postgres — seven of them run, one file has 7 cases plus the DB guard).

## What the next agent needs to know

1. **Task 10 (AppHost B) has its heartbeat already written but never run.** `push()` in
   `agents/licence-poll.ts` fires only with `INSTANCE_TOKEN` set, which no resource in AppHost A
   has. It posts `{version, tenantId, licenceId, productCount, orderCount}`; the platform route
   checks the tenant against the credential and answers 204. `licenceId` comes from the poll
   result on the same tick, so nothing new is stored.
2. **A dedicated store needs `INSTANCE_TOKEN` and `PLATFORM_URL` and must NOT be given
   `PLATFORM_INTERNAL_TOKEN`.** The agent prefers the instance token when both are set, but
   handing a box someone else owns a shared secret is the thing CE1 exists to stop.
3. **`docs/OPEN-DEFECTS.md` was sitting untracked** in the working tree when this task started —
   an RLS verifier's report, F1 being a real cross-tenant denial of service through single-column
   foreign keys. It is committed now, unchanged, in its own commit. **It is not fixed.**
4. Still outstanding from 04a: `apps/platform/src/schemas.ts` has not moved into
   `packages/contracts`. Still outstanding from 07b/07c: `packages/contracts/src/common.ts`
   imports two constants from `@mercatus/core`, so contracts still cannot be imported in a browser
   (the dashboard's `src/vendor/core-browser.ts` shim is still load-bearing).
5. `apps/store/test/licence-gate.test.ts` backdates `last_success_at` with raw SQL after
   `recordLicenceSuccess`. If the repository ever takes a clock, delete that line.

## Machine state

Left as found. `aspire stop` run; `docker ps` shows only `mercatus-dash-gate-pg` (task 07b's
leftover, on 55432, which predates this task and was reused for the store test run) and
`chess-trainer` (pre-existing). The storefront, both Vite servers and the hand-restarted platform
were killed; ports 3001, 4001, 5173 and 5174 are free. The Chrome tab this task opened was closed.
