# 12.1 — the repair pass

## Postgres: tenant-consistent foreign keys

- A single-column FK **crosses tenants**, whatever your RLS says: referential-integrity checks run
  with row security OFF, so `with check` validates a row's own `tenant_id` and never its parent.
  The fix is `unique (id, tenant_id)` on the parent and a composite FK. Verified on 18.3.
- A composite FK works against a **UNIQUE CONSTRAINT**. `uniqueIndex(...)` in drizzle emits
  `CREATE UNIQUE INDEX`, which pg does accept as an FK target, but `unique('name').on(...)` emits
  `ADD CONSTRAINT ... UNIQUE` and is the unambiguous spelling. Both are in the schema now.
- **drizzle-kit 0.31.11 emits `ADD CONSTRAINT ... UNIQUE` AFTER the foreign keys that reference
  it** in an incremental migration, and Postgres refuses that ("there is no unique constraint
  matching given keys for referenced table"). A from-scratch generation is fine, because the
  uniques are inline in `CREATE TABLE`. Since every database here is created per run, the answer
  was `rm -rf migrations && drizzle-kit generate --name=…`, not hand-ordering the SQL (J1).
- `drizzle-kit generate` still needs `DATABASE_ADMIN_URL` set even though it never connects:
  `drizzle.config.ts` reads it eagerly. Any junk URL does.
- `db.execute<Row>()` needs `Row extends Record<string, unknown>`, or TS2344.

## Proving F1 both ways on a throwaway database

- The whole reproduction is: seed two tenants as `mercatus_owner` (inside `set_config` blocks,
  because FORCE binds the owner), then as `mercatus_app` in tenant B's context insert an
  `order_lines` row carrying B's `tenant_id` and A's `order_id`. Old FKs: `INSERT 0 1`, and A's
  own `delete from orders` then fails for ever. New FKs: `23503`, and A deletes its own order.
- **`psql -q` swallows `INSERT 0 1` and `DELETE 1`.** Running the attack script quietly makes a
  successful plant look like nothing happened, and the only line you see is an unrelated error.
  Drop `-q` for anything whose command tag IS the result.
- A destructive probe consumes its fixture. The second run of the same script failed for a
  completely different reason (the parent row was already gone) and looked like the fix working.
  Re-seed between runs, or you will draw the wrong conclusion twice.

## SECURITY DEFINER, done properly

```sql
create or replace function mercatus_tenant_by_slug(p_slug text)
returns table (id uuid, slug text, name text, branding jsonb, updated_at timestamptz)
language sql stable security definer set search_path = public, pg_temp
as $fn$ select ... $fn$;
revoke all on function mercatus_tenant_by_slug(text) from public;   -- EXECUTE is PUBLIC by default
grant execute on function mercatus_tenant_by_slug(text) to mercatus_app;
```

- `$$ ... $$` inside a file that is already being run through `client.unsafe(text).simple()` is
  fine, but use a **named delimiter** (`$fn$`) so it can never collide with a surrounding `DO $$`.
- `revoke all on schema public from mercatus_app` does **not** remove function EXECUTE. Revoke the
  function separately.
- Checking PUBLIC's database privileges from a test:
  `select count(*) from aclexplode((select datacl from pg_database where datname = current_database())) where grantee = 0 and privilege_type = 'CONNECT'`.
  `grantee = 0` is PUBLIC; `has_database_privilege('public', ...)` does not work, PUBLIC is not a
  role.

## Vitest: make a suite unable to skip

- The pattern is `globalSetup` + `project.provide(...)` + `inject(...)` inside `beforeAll`, and it
  is worth extracting: `packages/db-{store,platform}/test/harness.ts` is exported as
  `@mercatus/db-store/testing` (an `exports` subpath) and imported by `apps/store` and
  `apps/platform`. The harness file lives in the db package, so `@testcontainers/postgresql`
  resolves from **that** package's node_modules — the app does not need the dependency.
- `inject()` only works inside a test file's hooks, so module-level `const url = process.env[...]`
  becomes `let url = ''` assigned in `beforeAll`.
- Un-skipping a suite finds real gaps: `apps/platform`'s 22 tests needed the platform seed
  (`acme` must exist for "refuses an installation for a pooled tenant"). Two failures on the first
  honest run, both fixture, neither a product bug.
- After this, `pnpm -r test` is 235 tests, 0 skipped: core 26, contracts 25, db-platform 11,
  fake-bank 17, platform 22, db-store 98, store 36.

## Aspire / the edge

- Traefik reaches host processes over `host.docker.internal`, so anything it fronts must bind
  `0.0.0.0`. `vite --host 127.0.0.1` is unreachable from the edge; `--host 0.0.0.0` plus
  `server.allowedHosts: ['.localtest.me']` in `vite.config.ts` is what makes
  `dash.localtest.me:8080` work (Vite refuses an unknown `Host` header with a 403 page).
- `next dev` already binds all interfaces, but needs the hostname in `allowedDevOrigins` or the
  dev-only requests hydration waits on are refused (lesson 07a, one host further).
- Routing by **hostname per surface** avoids the collision that killed the obvious idea: the store
  API and the storefront both serve `/t/:slug`, so a `PathPrefix('/t/')` router cannot separate
  them. `shop.` / `dash.` / `console.` / `api.` / `platform.` / `bank.` and a catch-all to the API.
- `aspire stop` returns before its containers are gone. Poll `docker ps`, do not assert straight
  after.
- Reading a detached AppHost's resource output: `ls -dt /tmp/aspire-dcp* | head -1`, then the
  `<uuid>_out` files in it. `grep` for a line you printed; the file names are not the resource
  names.

## Relaunching a process the orchestrator did not start

- `03-dedicated-outage.spec.ts` kills the Aspire-managed platform and restarts it by hand, and
  `aspire stop` will not reap what it did not start. Fix: spawn it under a tiny `.mjs` supervisor
  that polls `process.kill(watchPid, 0)` and kills the child when that pid disappears. The watch
  target is the **PPid of the captured process** (`/proc/<pid>/status`), which is DCP.
- **Inherit the watch pid on a re-run.** The second run's process on 4001 is the first run's
  supervised child, whose parent is that supervisor — and the supervisor exits the moment its
  child is killed, so watching it makes the relaunch die about a second after it starts. Symptom:
  run 1 green, run 2 fails only on "catches up when the control plane comes back". Read
  `MERCATUS_WATCH_PID` out of the captured environment first, fall back to the PPid.
- ESLint 10 with typescript-eslint has `no-undef` ON for `.mjs` (it is only turned off for TS), so
  a plain node script needs a `languageOptions.globals` block for `process`, `setInterval`, …

## Playwright suites that survive a second run

- Assert **arithmetic, not literals**: take each tenant's order count in `beforeAll` and assert
  `before + 1`. A suite that demands a freshly built stack is a suite that runs once.
- Mint a fresh shopper per run (`freshShopper()`), so "1 order at this store" stays true for that
  person however many orders the store already has.
- `let context: BrowserContext | undefined` and `await context?.close()`. A `beforeAll` that
  throws otherwise adds `TypeError: Cannot read properties of undefined (reading 'close')` on top
  of the real failure and buries it.
- `page.getByRole('link', { name: 'Lines' })` is strict-mode ambiguous once the table has more
  than one row. `.first()`.

## Small things

- `pnpm -r test` inherits the whole environment; `turbo run test` passes only what `turbo.json`
  names. With the suites owning their databases, that list is down to `MERCATUS_LEAK_SABOTAGE`.
- Two Zod schemas called `paymentStatusSchema` in one barrel is `TS2308: Module has already
  exported a member named ...`. The store's is `orderPaymentStatusSchema`.
- The bash tool kills a foreground command at 120s. `pnpm test:e2e` takes ~45s when it passes and
  up to 3 minutes when something times out — run it backgrounded and poll the output file.
