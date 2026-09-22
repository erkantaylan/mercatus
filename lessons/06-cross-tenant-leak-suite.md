# 06 — Testcontainers, vitest global setup, and writing a leak suite that can fail

## Testcontainers with pnpm 12

- `testcontainers` / `@testcontainers/postgresql` **12.1.0**. Both installed clean against
  vitest 5.0.1 and node 22.23.2.
- The install fails exactly as lesson 01/05 describe, with a new pair:
  `ERR_PNPM_IGNORED_BUILDS … Ignored build scripts: cpu-features@0.0.10, ssh2@1.17.0`. Both come
  from `dockerode` and are the optional `ssh://` docker transport. They are the first case in this
  repo where the right answer is **`false`, not `true`**:

  ```yaml
  allowBuilds:
    cpu-features: false
    ssh2: false
  ```

  Nothing needs to go into `onlyBuiltDependencies:` for a denied build. Everything still works —
  testcontainers talks to the local docker socket.
- The failed install again left `cpu-features: set this to true or false` in the file. Re-read
  `pnpm-workspace.yaml` after **every** failed install before editing it.
- After the fix `pnpm install` printed `Lockfile is up to date … Done in 25ms` and added nothing:
  the packages had already been written by the run that then failed on the build gate. A "no-op"
  second install is the expected outcome, not a sign the fix did not take.
- `testcontainers/ryuk:0.9.0` was cached but 12.1.0 pulls **0.14.0**. First run pays for that pull.
- Container start on a cached `postgres:18.3`, plus roles + drizzle migrate + RLS:
  **~2.3s**. First start of the session: 6.2s.

## vitest 5.0.1 global setup

- `globalSetup: ['./test/global-setup.ts']` in `vitest.config.ts`. The file is TypeScript and needs
  no separate transform.
- **Return the teardown from the default export.** `export default setup` + `export async function
  teardown` did **not** run the teardown — the container survived vitest's exit and was left for
  Ryuk to reap 15–30s later. `export default async function setup(project): Promise<() =>
  Promise<void>>` returning the closure works; the proof is a `process.stdout.write` in the closure
  and `docker ps` being clean the instant the command returns.
- Passing values to the suites: `project.provide('storeDb', {...})` in setup, `inject('storeDb')`
  from `'vitest'` inside `beforeAll`. Needs

  ```ts
  declare module 'vitest' {
    interface ProvidedContext { storeDb: StoreDbUrls }
  }
  ```

  in the global-setup file. `interface`, not `export interface` — augmentation only.
  Do **not** try to set `process.env` in global setup and read it in a test file.
- `spawnSync('drizzle-kit', …)` from global setup: resolve
  `<pkg>/node_modules/.bin/drizzle-kit` explicitly. Global setup does not reliably inherit the
  package's `node_modules/.bin` on PATH.
- `fileParallelism: false` when several files share one database. Costs nothing here (5s total).
- Vitest's exit code is 1 on failure, but `vitest run | tail` reports **tail's** exit code. Redirect
  to a file and read `$?`, or the RED half of the gate silently looks like a pass.

## turbo caches test results

- `turbo run test` replays a cached green. `MERCATUS_LEAK_SABOTAGE` had to be added to
  `turbo.json` → `tasks.test.env` or the sabotage run would be served from cache. Any env var that
  changes what a test asserts belongs in that list.

## Writing the leak suite

- **The env-var-gated suite was the bug.** The previous `leak.test.ts` did
  `describe.runIf(hasDb)` on `DATABASE_URL` and skipped clean on any machine without one — a green
  `pnpm test` that proved nothing. Owning the container removes the skip path entirely. `pnpm check`
  still shows `22 skipped` in `apps/platform` for the same reason; the fix is these same three
  files.
- **The sabotage must be a policy swap, not `disable row level security`.** Replacing
  `<table>_tenant_isolation` with `using (true) with check (true)` leaves `relrowsecurity` and
  `relforcerowsecurity` true, so the *coverage* assertions stay green and only the *leak*
  assertions go red. Disabling RLS reddens both and tells you less.
- Measured, per sabotaged table: **`products` → 7 red**, **`shoppers` → 8 red**,
  **`orders` → 10 red**. Which BI2 tests fire depends on which policy you break, and that is worth
  knowing before you trust one of them:
  - `orders` open → the three order-shaped BI2 tests go red (a borg order id resolves inside acme,
    borg's shopper id matches rows inside acme, borg's own count goes 2 → 3).
  - `shoppers` open → only `a raw subject-only select inside acme still sees exactly one shopper`
    goes red. The `listOrdersForSubject` tests stay **green**, because the join runs through
    `orders.shopper_id` and the *orders* policy is what holds them up. So the BI2 section needs
    both shapes of assertion; neither alone covers the other's break.
  - Nastier: with `shoppers` open, `findShopperBySubject` (`… limit 1`, no order by) still returned
    acme's row — this run. It is a coin flip, not a guarantee. Any repository that ends in
    `limit 1` with no tenant predicate is invisible to a test that only checks the row it got back;
    assert the **count**.
- A cross-tenant `insert` that succeeds under sabotage **persists for the rest of the run**, and a
  later test reads it back. `inside borg, the same subject has 2` failed with `expected 3 to be 2`:
  the third order was the row acme planted. Good evidence, and a reason to keep the fixture counts
  asymmetric (1 / 2 / 3 are three distinguishable answers; 1 / 1 / 2 are not).
- **Foreign-key checks bypass RLS.** RI triggers run with row security off, so a cross-tenant
  `insert into orders (… shopper_id = <borg's shopper>)` passes the FK and is then refused by
  `with check` — 42501, which is what you want to assert. It also means an unfiltered
  `delete from products` under sabotage fails with **23503**, not with a row count: acme reached
  borg's rows and only the FK stopped it. Assert on the error, not only on counts.
- You can `set_config('app.tenant_id', …, true)` **twice in one transaction**. That is what makes
  the "unfiltered delete" test possible: delete everything as A, switch to B, count what survived,
  then roll back by throwing.
- Rolling back on purpose: throw a sentinel and match on `error.name`, not `instanceof` — drizzle
  and postgres.js both rethrow, but the class identity is not worth relying on.
- `expect(theirs).toEqual([])` on an array of leaked **rows** beats `expect(count).toBe(0)`: the
  failure output names the tenant that leaked.
- `sql.raw(table)` for identifiers (lesson 02, still true), and `${value}::uuid` for a uuid column
  compared against a JS string is safe with postgres.js either way.

## Small things

- `noImplicitOverride` + a sentinel error class: `public override readonly name = 'RollbackSignal'`.
- `let x: Record<string, number> = {}` that is only ever mutated trips `prefer-const`. `const`.
- Nothing in this task needed the AppHost. `aspire run` was never started.
