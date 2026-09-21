# 02 — schemas, RLS and contracts

**Status:** done

**Gate:** executed, not claimed. From a brand-new `postgres:18.3` container:

```
pnpm --filter @mercatus/db-store    migrate --seed   # roles -> drizzle-kit migrate -> RLS -> seed
pnpm --filter @mercatus/db-platform migrate --seed
pnpm -r test                                          # 112 tests, 4 packages, all green
```

then the isolation proof by hand, as `mercatus_app`, in `psql`: `rolbypassrls = f`; the same
`select * from products` returns **4 acme rows** inside a transaction that set
`app.tenant_id = <acme>`, **3 borg rows** inside one that set borg, and **0 rows with no error**
outside any transaction; an insert carrying borg's `tenant_id` from inside acme's transaction is
refused with `new row violates row-level security policy for table "products"`; `update` and
`delete` of borg rows from inside acme's transaction report `UPDATE 0` / `DELETE 0`. The full
transcript is in the task report.

The leak suite was also checked for the other failure mode — passing vacuously. Granting
`mercatus_app` `BYPASSRLS` and re-running turned **35 of 69** tests red; revoking it turned them
green again.

## What I built

`packages/db-store` — the data plane.

- `src/schema.ts` — 7 tables. `tenants` (no RLS, the context lookup), `licence_state`, `products`,
  `shoppers`, `orders`, `order_lines`, `order_counters`. Every uniqueness constraint is composite
  and leads with `tenant_id` (BG1); a test asserts that mechanically over the generated SQL.
  Exports `RLS_TABLES`, which the leak suite iterates.
- `sql/00-roles.sql` — `mercatus_owner` and `mercatus_app`, both
  `nosuperuser nobypassrls nocreatedb nocreaterole` and re-asserted on every run (BE2).
- `sql/02-rls.sql` — hand-authored, not generated. `enable` + `force` + one policy per table using
  `nullif(current_setting('app.tenant_id', true), '')::uuid`, plus the grants. `tenants` gets
  `select` only.
- `src/tenant-tx.ts` — `withTenantTx` (tenant from `currentTenant()`) and `withExplicitTenantTx`
  (tenant passed in — migrations, seeds, tests only).
- `src/client.ts` — `createStoreDb`, and `StoreTx` derived from the driver rather than hand-typed.
- `src/repositories/` — `tenants` (the one file allowed a tenant predicate), `products`,
  `shoppers`, `orders`, `licence-state`.
- `src/migrate.ts` — the ordered init step. `src/seed.ts` — acme (4 products) and borg (3).
- `test/` — 69 tests in four files, described below.

`packages/db-platform` — the control plane. 6 tables, no RLS (one database, one tenant, us), its
own `mercatus_platform_owner` / `mercatus_platform_app` roles, migrations, grants, seed, and 10
schema-invariant tests.

`packages/contracts` — `common.ts`, `store.ts`, `platform.ts` beside the existing `errors.ts`:
Zod schemas for every entity and every endpoint in BUILD-PLAN §6.1 and §6.2, plus 25 tests.

`packages/core/src/errors.ts` — added `ProductNotFoundError` and `OrderNotFoundError`. Both codes
were already in `ERROR_CODES` with no class to throw them.

## The tests, and what each is for

| file | needs a DB | what it protects |
|---|---|---|
| `test/leak.test.ts` | yes | BL1. Per RLS table: acme sees only acme; no context = 0 rows, no error; cross-tenant insert refused by `with check`; cross-tenant update/delete = 0 rows. Plus `rolbypassrls = false` and a live `pg_class` check that `force` is really on |
| `test/order-number.test.ts` | yes | BG2. acme gets 1, 2, 3 while borg independently gets 1, 2; a rolled-back transaction does not burn a number; no tenant context refuses rather than invents; stock cannot go negative |
| `test/rls-coverage.test.ts` | no | the "new table, forgotten policy" failure. Parses the migrations and `02-rls.sql` and requires enable + force + policy + grant for every table that is not the documented exception |
| `test/no-tenant-filters.test.ts` | no | §3.5. Greps `apps/store/src` and `packages/db-store/src` for `where tenant_id =` and `eq(x.tenantId, …)`. Lit now, so task 03 meets it already written |

## What the next agent needs to know

1. **`pnpm --filter @mercatus/db-store test` skips the two DB suites silently-but-loudly when
   `DATABASE_URL` and `DATABASE_ADMIN_URL` are unset** — it prints a SKIPPED banner to stderr.
   The two file-parsing suites still run. Set both variables, or you are testing less than you think.
2. **Three connection strings, not two.** `DATABASE_SUPERUSER_URL` is new (see
   `decisions-made-overnight.md`): creating a role needs a role-creating connection, and
   `DATABASE_ADMIN_URL` is `mercatus_owner`, which deliberately cannot. It defaults to
   `DATABASE_ADMIN_URL` when unset, which is what will happen under Aspire.
3. **Dev passwords are literals in `sql/00-roles.sql`**: `mercatus_owner_dev`, `mercatus_app_dev`,
   `mercatus_platform_owner_dev`, `mercatus_platform_app_dev`. Task 09 wires the same strings into
   the AppHost.
4. **`apps/store` must not write `where tenant_id = …`.** `test/no-tenant-filters.test.ts` already
   greps for it and for the Drizzle form `eq(products.tenantId, …)`. The single exception is
   `packages/db-store/src/repositories/tenants.ts`.
5. **Take order numbers with `takeOrderNumber(tx)` or `placeOrder(tx, …)`**, never a sequence and
   never a `max(number) + 1`. `placeOrder` already does shopper upsert, counter, stock decrement,
   order and lines in one transaction — task 05 is wiring it to a route, not writing it.
6. **The seed tenant uuids are fixed literals** shared by both db packages:
   acme `3f6b0b8a-…-0a1b2c3d4e01`, borg `…e02`, the dev user `…e10`. A db-platform test reads
   db-store's seed as text and fails if they drift; do not "tidy" that into an import, because it
   would make the control plane depend on the data plane.
7. **`@mercatus/contracts` is no longer a stub.** Validate with it rather than writing new Zod in a
   route; if a shape is missing, add it there.
8. Machine left as found: container removed, `docker ps` shows only the unrelated `chess-trainer`,
   nothing bound on 55432, no `aspire run`, `~/.claude/settings.json` untouched.
