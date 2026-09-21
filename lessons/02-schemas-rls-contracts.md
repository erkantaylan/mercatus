# 02 — schemas, RLS and contracts

## Drizzle hides the RLS error, and a naive assertion passes for the wrong reason

```
AssertionError: expected [Function] to throw error matching /row-level security/i
  but got 'Failed query: insert into order_lines…'
```

- Drizzle wraps every driver error as `Failed query: <sql>\nparams: …` and hangs the real
  `PostgresError` off **`.cause`**. `expect(...).rejects.toThrow(/row-level security/)` fails even
  though the insert *was* refused.
- Worse: `.rejects.toThrow(/Failed query/)` would pass for **any** failure, including a typo in
  your own test fixture. Walk the `cause` chain and require both
  `new row violates row-level security policy` and `code=42501`.

## Drizzle / drizzle-kit 0.45.3 + 0.31.11, facts

- `db.execute(sql\`…\`)` on the postgres-js driver returns a plain **array of rows** (`rows[0].x`),
  not `{ rows }`. It takes a row type parameter: `tx.execute<{ id: string }>(sql\`…\`)`.
- `sql.raw(tableName)` is how you interpolate an identifier — `${table}` binds it as a *parameter*
  and the statement fails. Needed to write the leak suite as a loop over table names.
- `.for('update')` exists on the select builder and emits `for update`. `select … for update` with
  **no where clause** is exactly what BG2 wants, and drizzle does not object to a `where`-less
  `update()` either.
- `check()`, `primaryKey()`, `foreignKey()`, `uniqueIndex()`, `pgPolicy()`, `pgRole()` are all
  exported from `drizzle-orm/pg-core` at 0.45.3. The table-extras callback returns an **array**.
- `jsonb(...).$type<T>().notNull().default(sql\`'{}'::jsonb\`)` works; a bare `.default({})`
  generates a string literal default and is wrong.
- `bigint('number', { mode: 'number' })` gives a JS `number`, which is what you want unless you
  plan to exceed 2^53 orders.
- `drizzle-kit generate` needs **no database**; only `migrate` connects. But `drizzle.config.ts` is
  evaluated for both, so a config that throws on a missing env var breaks `generate` too — read
  the variable lazily or accept it.
- `defineConfig({ strict: true })` did not prompt for anything in non-interactive use.

## postgres.js: running a .sql file

- `client.unsafe(text)` uses the extended protocol → **one statement per round trip**, so a .sql
  file fails. `client.unsafe(text).simple()` switches to the simple protocol and runs the whole
  file, `DO $$ … $$` blocks included. This is the whole trick to `00-roles.sql`/`02-rls.sql`.

## Postgres role and RLS behaviour, verified on 18.3

- **`alter role … with login nosuperuser nobypassrls`** must be re-asserted on every run; `create
  role` inside a `do $$ … $$` guard only runs the first time, so a role someone made by hand keeps
  its attributes otherwise.
- `grant connect on database X to …` cannot be written literally when the database name is
  unknown. `do $$ begin execute format('grant connect on database %I to …', current_database());
  end $$;` works.
- **`revoke connect on database platform from public`** is a real, one-line control-plane / data-
  plane boundary: the store's `mercatus_app` then gets
  `FATAL: permission denied for database "platform"` even though both databases live in one
  cluster.
- `force row level security` binds the **owner** too, so the seed — which connects as the owner —
  has to run inside a tenant-scoped transaction like everything else. That is a feature: the seed
  exercises the same mechanism the application does.
- A **superuser still bypasses RLS even with FORCE**. Confirmed the other way round as well:
  `alter role mercatus_app with bypassrls` turned **35 of 69** leak-suite tests red. Run that
  experiment once — a leak suite that has never been seen to fail is not evidence.

## The empty-string GUC, reconfirmed

After any transaction that set `app.tenant_id`, `current_setting('app.tenant_id', true)` is `''`
— **not NULL** — for the rest of that session. Proven in the same psql session as the rest of the
gate:

```
 guc_is_empty_string | visible_outside_context
---------------------+-------------------------
 t                   |                       0
```

Without `nullif(…, '')` that second column is an error, not a zero, and only on connections that
previously served a tenant.

## Zod 4.6.5

- `z.uuid()`, `z.url()`, `z.iso.date()`, `z.iso.datetime({ offset: true })` are top-level; the
  `z.string().uuid()` chain still exists but is the old spelling.
- `z.record()` needs **two** arguments: `z.record(z.string(), z.boolean())`.
- `.partial().strict()` is what makes a PATCH body reject an unknown key. Without `.strict()` a
  typo'd field is silently dropped and the request returns 200 having changed nothing.
- `z.coerce.number()` on query strings works with `fastify-type-provider-zod`'s shape; `'20'`
  parses to `20`.

## Small things that cost minutes

- `pnpm --filter <pkg> migrate --seed` passes `--seed` through to the script. No `--` needed.
- The repo's ESLint bans `console.log` (`no-console` + `--max-warnings 0`), so migration and seed
  scripts print with `process.stdout.write`.
- pnpm 12 appended `drizzle-kit@0.31.11` and `drizzle-orm@0.45.3` to `minimumReleaseAgeExclude`
  in `pnpm-workspace.yaml` on install, as predicted by lesson 01. Left alone.
- `postgres:18.3` was already in the local image cache, so the throwaway container is up in ~2s.
  `docker run -e POSTGRES_USER=<role>` makes that role the **superuser** — not what you want if
  you are trying to prove `NOBYPASSRLS`. Bootstrap as `postgres` and create the real roles in SQL.
