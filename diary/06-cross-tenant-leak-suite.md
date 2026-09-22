# 06 — the cross-tenant leak suite

**Status:** done
**Gate:** `vitest run` in `packages/db-store`, four times — three with a different RLS policy
deliberately broken (RED, exit 1 each) and one intact (GREEN, exit 0). Pasted below.

## What I built

`packages/db-store/`

| File | |
|---|---|
| `test/global-setup.ts` | **new.** Brings up `postgres:18.3` with Testcontainers, runs `sql/00-roles.sql` → `drizzle-kit migrate` → `sql/02-rls.sql`, hands the three URLs to the suites via `project.provide('storeDb', …)`, and stops the container in the teardown it returns. Also the **sabotage hook**: `MERCATUS_LEAK_SABOTAGE=<table>` swaps that table's isolation policy for `using (true) with check (true)` after the migrations and before any test |
| `test/fixture.ts` | **new.** `seedTwoTenants()` — acme and borg, a row in every RLS table for both, deliberately asymmetric counts. Holds the BI2 layout: one shared shopper subject, 1 order at acme and 2 at borg, plus a second acme-only shopper |
| `test/leak.test.ts` | **rewritten.** 52 tests |
| `vitest.config.ts` | **new.** `globalSetup`, `fileParallelism: false`, longer hook timeout |
| `test/order-number.test.ts` | now takes its database from the same container instead of `DATABASE_URL`; `describe.runIf(hasDb)` removed |
| `package.json` | `+ testcontainers`, `+ @testcontainers/postgresql` (devDeps) |
| `tsconfig.json` | `+ vitest.config.ts` in `include` |

Root: `pnpm-workspace.yaml` (catalog entries, and `cpu-features`/`ssh2` answered `false` in
`allowBuilds`), `turbo.json` (`MERCATUS_LEAK_SABOTAGE` added to the `test` task's `env`, so turbo
cannot replay a cached green over a sabotaged run).

## What the suite asserts

Every statement is issued as `mercatus_app` — LOGIN, NOBYPASSRLS, no schema privileges.

Three preconditions: the connected role is neither superuser nor `BYPASSRLS`; every table in
`RLS_TABLES` is `relrowsecurity` **and** `relforcerowsecurity` in the live catalog while `tenants`
is neither; and the app role cannot `alter table … disable row level security`.

Then, for each of the six RLS tables, inside acme's transaction: every visible row is acme's and
there is at least one; a direct lookup of borg's row by its own primary key finds nothing; an
update targeting borg's rows affects 0; a delete targeting borg's rows affects 0; an insert
carrying borg's `tenant_id` is refused with `new row violates row-level security policy` and
`code=42501` walked off the `cause` chain; and with no tenant context at all the table reads 0
rows without raising.

Three things the per-table loop does not reach:

- **The forgotten WHERE clause.** One transaction: set the GUC to acme, `delete from <every table>`
  with no predicate in FK order, then set the GUC to borg *in the same transaction* and re-count.
  Borg's six counts must be identical to what they were. Rolled back by a sentinel throw.
- **`tenants`.** The one table with no RLS is held by grants instead: select yes; insert, update
  and delete each `permission denied`, `code=42501`.
- **BI2**, eight tests. The shared subject is two different shopper rows. Inside acme it resolves
  to acme's row; `listOrdersForSubject` returns 1 order, not the 3 that subject owns platform-wide;
  inside borg the same call returns 2, so the 1 is scoping and not an empty table; an order id the
  shopper genuinely owns **at borg**, presented to acme, is a not-found; borg's shopper id
  presented to acme matches nothing; and a subject-only select inside acme still sees exactly one
  shopper row.

## Gate

RED, `products` isolation replaced with `using (true)`:

```
$ MERCATUS_LEAK_SABOTAGE=products ./node_modules/.bin/vitest run ; echo EXIT=$?

  !! SABOTAGE: products_tenant_isolation replaced with using(true). The suite MUST go red.

 FAIL  test/leak.test.ts > … > products > inside acme, every visible row belongs to acme -- and there is at least one
 FAIL  test/leak.test.ts > … > products > a direct lookup of borg's row, by its own primary key, finds nothing
 FAIL  test/leak.test.ts > … > products > an update of borg's rows from inside acme affects 0 rows
 FAIL  test/leak.test.ts > … > products > a delete of borg's rows from inside acme affects 0 rows
 FAIL  test/leak.test.ts > … > products > `with check` refuses an insert carrying borg's tenant_id
 FAIL  test/leak.test.ts > … > products > with no tenant context at all: 0 rows, and no error
 FAIL  test/leak.test.ts > … > the forgotten WHERE clause (BE1) > an unfiltered delete of every table inside acme leaves borg's rows untouched
 FAIL  test/order-number.test.ts [ test/order-number.test.ts ]

 Test Files  2 failed | 2 passed (4)
      Tests  7 failed | 81 passed (88)
EXIT=1
```

The individual failures are the right ones: `expected 3 to be +0` on the no-context read,
`expected '' not to be ''` on the `with check` insert (an empty error string means the insert
**succeeded**), and `23503 … Key is still referenced from table "order_lines"` on the unfiltered
delete — acme reached borg's products and only a foreign key stopped it.

RED, `orders` isolation replaced instead — this is the run that shows the BI2 tests are real:

```
$ MERCATUS_LEAK_SABOTAGE=orders ./node_modules/.bin/vitest run ; echo EXIT=$?

 FAIL  … > orders > inside acme, every visible row belongs to acme -- and there is at least one
 FAIL  … > orders > a direct lookup of borg's row, by its own primary key, finds nothing
 FAIL  … > orders > an update of borg's rows from inside acme affects 0 rows
 FAIL  … > orders > a delete of borg's rows from inside acme affects 0 rows
 FAIL  … > orders > `with check` refuses an insert carrying borg's tenant_id
 FAIL  … > orders > with no tenant context at all: 0 rows, and no error
 FAIL  … > the forgotten WHERE clause (BE1) > an unfiltered delete of every table inside acme leaves borg's rows untouched
 FAIL  … > (BI2) > inside borg, the same subject has 2 -- so the 1 above is scoping, not an empty table
 FAIL  … > (BI2) > asking store acme for an order the shopper really owns -- at borg -- is a not-found
 FAIL  … > (BI2) > borg's shopper id, presented to acme, matches nothing

 Test Files  2 failed | 2 passed (4)
      Tests  10 failed | 78 passed (88)
EXIT=1
```

`inside borg, the same subject has 2` failed with **`expected 3 to be 2`**, and the third order is
the one acme planted three tests earlier through the now-permissive `with check`. A cross-tenant
write became a row borg's own shopper reads back as theirs. That is the leak, end to end, in one
number.

A third run, `MERCATUS_LEAK_SABOTAGE=shoppers`, exits 1 with **8 failed | 80 passed** — the six
`shoppers` probes, the unfiltered delete, and exactly one BI2 test (`a raw subject-only select
inside acme still sees exactly one shopper`). The `listOrdersForSubject` assertions stay green
there, because that join hangs off `orders.shopper_id` and it is the *orders* policy holding them
up. Recorded in `lessons/06` — it is the reason the BI2 section carries both shapes of assertion.

GREEN, nothing sabotaged:

```
$ ./node_modules/.bin/vitest run ; echo EXIT=$?
db-store tests: starting postgres:18.3 (Testcontainers)
[✓] migrations applied successfully!
db-store tests: database ready on localhost:32780 in 2322ms
 ✓ test/leak.test.ts (52 tests) 172ms
 ✓ test/order-number.test.ts (4 tests) 130ms
 ✓ test/rls-coverage.test.ts (29 tests) 7ms
 ✓ test/no-tenant-filters.test.ts (3 tests) 4ms

 Test Files  4 passed (4)
      Tests  88 passed (88)
   Duration  4.99s
db-store tests: database stopped
EXIT=0
```

Repo-wide: `pnpm check` → `23 successful, 23 total`, exit 0.

## What does not work yet

- **`apps/platform` and `apps/store` tests still skip themselves.** `pnpm check` reports
  `22 skipped` for platform; both read `PLATFORM_DATABASE_URL` / `DATABASE_URL` and
  `describe.runIf` away when unset. That is the same disease this task cured in `db-store` and the
  cure is the same three files. Not done here — the task was the data-plane leak suite.
- **The suite covers the data plane only.** The control-plane schema has no RLS (grants only), so
  there is nothing for a leak suite to iterate there yet.
- The two defects the task brief carried forward from the AppHost verification are **untouched**:
  `PgInstrumentation` is dead code against postgres.js, and a pooled host/path tenant disagreement
  is served rather than refused (`packages/core/src/auth/plugin.ts:98-99`). Neither is an RLS leak;
  neither is fixed.

## State left behind

Nothing running. `docker ps` shows only the pre-existing `chess-trainer`. No AppHost was started
for this task — the leak suite needs a database, not a topology. The test container is created and
removed per run; verified that `db-store tests: database stopped` prints and the container is gone
from `docker ps` immediately after the run, rather than being left to Ryuk.
