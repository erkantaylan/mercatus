# 03 — apps/store, the data plane API

## Turbo hides your database env, and the suite goes green anyway

- `pnpm turbo run test` with `DATABASE_URL` exported in the shell still ran the db-store suite as
  **32 passed / 37 skipped**, printing the SKIPPED banner, and reported `Tasks: 5 successful`.
  Turbo passes a task only the variables its `env` list names.
- Fixed in `turbo.json`:
  `"test": { "outputs": [], "env": ["DATABASE_URL","DATABASE_ADMIN_URL","DATABASE_SUPERUSER_URL","AUTH_STUB_SECRET"] }`
  After that: `69 passed (4 files)`, nothing skipped.
- `pnpm -r test` does not have this problem — it is pnpm, not turbo, so the whole environment is
  inherited. The two commands were not testing the same thing, and the root `check` script uses
  turbo.

## Scalar and @fastify/swagger, versions in the catalog

- `@scalar/fastify-api-reference@1.70.0` with `routePrefix: '/docs'` serves:
  `/docs` → **301**, `/docs/` → 200 (the page), `/docs/openapi.json` → 200 (the document).
  `/docs/json`, `/openapi.json` and `/documentation/json` are all **404**.
- `fastify-type-provider-zod@7.0.0` exports exactly: `validatorCompiler`, `serializerCompiler`,
  `jsonSchemaTransform`, `jsonSchemaTransformObject`, `createJsonSchemaTransform`,
  `createSerializerCompiler`, `hasZodFastifySchemaValidationErrors`,
  `isResponseSerializationError`, `ResponseSerializationError`, `InvalidSchemaError`, and the
  `ZodTypeProvider` / `FastifyPluginAsyncZod` types. There is no `dist/index.d.ts` — it is
  `dist/esm/index.d.ts`, so read the typings there.
- `hasZodFastifySchemaValidationErrors(error)` narrows the error so `error.validation` is typed.
  It is the only reliable way to tell a 400 from a 500 in `setErrorHandler`.
- A response is **serialised through its Zod schema**, so a field the schema does not mention is
  silently dropped from the reply. Adding `mode` to `/health` meant extending the schema in
  `@mercatus/contracts`, not just returning more from the handler.

## Fastify 5 details that cost minutes

- `disableRequestLogging: false` is **deprecated** (`FSTDEP023`) and prints a warning at every
  boot. Leave the option out.
- `request.hostname` excludes the port in Fastify 5, but a raw `Host: acme.localtest.me:4002`
  header can still carry one — strip at `:` before matching the base host.
- `app.withTypeProvider<ZodTypeProvider>()` returns a differently-typed instance. Export the alias
  once (`MercatusServer` in `packages/core/src/http/server.ts`) and type every
  `register*Routes(app: MercatusServer, …)` with it; re-deriving it per file is noise.
- Registering hooks and decorators directly on the instance avoids needing `fastify-plugin` (which
  is not in the catalog). `app.decorateRequest('principal', null)` plus
  `declare module 'fastify'` is the whole of it.

## AsyncLocalStorage across Fastify hooks — do not try it

- Context established inside an `async` `onRequest` hook does **not** reach the handler: the hook's
  async scope ends when it resolves. The `als.run(ctx, done)` trick works only from a *sync* hook,
  and `enterWith()` risks the context outliving the request on a keep-alive connection — which in
  this codebase would be a cross-tenant leak, i.e. the exact thing being defended against.
- What is done instead: the hook computes the `TenantContext` and parks it on
  `request.tenantContext`; every handler goes through one helper
  (`inTenantTx(deps, req, fn)` = `runInTenant(ctx, () => withTenantTx(db, fn))`). One call per
  handler, no ambient magic, and a handler that forgets it fails loudly at the first query with
  `MissingTenantContextError` rather than quietly reading nothing.

## Proving the transaction actually sets the tenant

```
docker exec <ctr> psql -U postgres -d store -c "alter system set log_statement='all';"
docker exec <ctr> psql -U postgres -c "select pg_reload_conf();"
docker logs <ctr> 2>&1 | grep -E "LOG:  (statement|execute)"
```

`set_config` binds a parameter, so it logs as `execute <unnamed>: select set_config(...)` and
**not** as `LOG: statement:` — grepping only for `statement` makes it look as though the GUC is
never set. `begin` and `commit` do appear as `statement`.

## Zod 4 / contracts

- `z.iso.datetime({ offset: true })` accepts `new Date().toISOString()` (the `Z` form) as well as
  `+03:00`. No custom serialiser needed.
- A `.partial().strict()` PATCH body reports `Unrecognized key: "titel"` with `instancePath` `"/"`,
  not the key's own path. Put the key in the message, not the path, when building the 400.
- `z.enum([...])` from a `const` array of literals works directly with `ERROR_CODES`; no
  `as unknown as [string, ...string[]]` cast is needed at 4.6.5.

## Postgres / drizzle

- A duplicate `(tenant_id, sku)` arrives as a drizzle `Failed query:` wrapper — the constraint
  name `products_tenant_sku_uq` is only on `.cause`. Same walk-the-chain rule as lesson 02; one
  `violates(error, constraintName)` helper covers both that and the `order_lines_product_id` FK
  that blocks deleting a product which has been sold.
- `select count(*)::int` is logged as a plain statement (no parameters) while the row query is
  prepared — useful when reading the server log to confirm neither carries a tenant predicate.

## Small things

- `pkill -f "tsx src/index.ts"` **kills your own shell**, because the pattern matches the bash
  command line that contains it. Exit code 144, no output, very confusing. Kill by port instead:
  `ss -ltnp | grep :4002` → `kill <pid>`.
- An app with a `test` script and no test files fails `pnpm -r test` with
  `No test files found, exiting with code 1`. Either write a test or do not declare the script.
- `docker run -e POSTGRES_PASSWORD=… postgres:18.3` then
  `psql -U postgres -c "create database store"` is enough; `sql/00-roles.sql` takes ownership of
  whatever database it is pointed at via `current_database()`.
