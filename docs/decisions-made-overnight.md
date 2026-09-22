# Decisions made overnight

Decisions the design docs did not make, taken by build agents so the build could continue.
One bullet, one reason. Newest section at the bottom. The design docs are not rewritten; this
file is where they are amended.

## Task 00 — recon and build plan

- **Traefik takes port 8090, not 8080.** `qbittorrent` already listens on `*:8080` on this
  machine, so the port named in the brief is not available.
- **Dashboard and admin are Vite + React + TanStack Router SPAs, not TanStack Start**, and the UI
  is plain CSS with design tokens, not Fluent UI v9. This contradicts the stack table in
  `README.md`; the standing decisions for this build override it, and an SPA plus a small
  component set is less to get wrong in a learning POC.
- **`packages/clients` is not built; `packages/ui` takes its slot in the layout.** No Orval, no
  Kubb, no generated client. `@mercatus/contracts` holds the Zod schemas, each app has a ~40-line
  typed fetch wrapper that parses with them, and OpenAPI generation stops at the Scalar docs page.
  Codegen is a toolchain to debug at 3am for a POC whose whole API is thirty endpoints.
- **`fastify-type-provider-zod`, `@fastify/swagger` and Scalar stay** — one plugin each, and they
  keep the route types tied to the schemas, which is the part that was actually worth having.
- **TypeScript is pinned to 5.9.3, not `latest` (7.0.2).** `typescript-eslint@8.70.1` declares
  `peerDependencies.typescript: ">=4.8.4 <6.1.0"`, so TypeScript 7 breaks linting at install.
  `@types/node` is pinned to `^22`, matching the Node version, not `latest` (26.x).
- **Aspire Node resources use `Aspire.Hosting.JavaScript@13.5.4`, not `Aspire.Hosting.NodeJs`.**
  The latter is frozen at 9.5.2 and does not match the 13.5.x AppHost SDK.
- **The AppHosts live in `aspire/control-plane/` and `aspire/acme-vps/`**, replacing the single
  `aspire/AppHost` in the README layout, because the design settled on two AppHosts.
  The dedicated tenant is **`zenith`**, so the folder name and the tenant slug do not have to
  agree and nobody assumes `acme` means "the dedicated one" — `acme` is a pooled tenant.
- **The data plane's `tenants` table is the one table without RLS**, granted `select` only to the
  app role. It is the lookup that establishes tenant context, so it cannot itself require it.
  Every other data-plane table has `enable` + `force row level security`.
- **RLS policies use `nullif(current_setting('app.tenant_id', true), '')::uuid`.** Verified on
  `postgres:18.3`: after a transaction that set the GUC, the session value reverts to the empty
  string rather than NULL, and `''::uuid` raises. Without the `nullif`, a reused pooled connection
  fails with a cast error instead of returning zero rows.
- **The tenant is pushed with `set_config('app.tenant_id', $1, true)`, not `SET LOCAL`.** `SET`
  does not take bind parameters; `set_config` does, so the tenant id never reaches SQL as text.
- **`apps/store` never writes `where tenant_id = …`.** Defence in depth would make the RLS
  guarantee untestable, which is the entire point of `BE1`. A grep in the leak suite enforces it.
- **Money is an integer in minor units** (`price_minor`, `total_minor`, `amount_minor`) with a
  separate `currency` column defaulting to `'TRY'`. The ER diagram says `numeric`; integers remove
  a whole class of rounding bug from a POC that does not need decimals.
- **Concrete numbers for `CG2`:** licence poll every 10s; grace window 259200s (72h), overridden
  to 60s in the demo profile; JWKS cached 24h and served stale indefinitely while unreachable.
- **`aspire new` must be run with `--suppress-agent-init`.** Without it, it writes a `PostToolUse`
  hook into the user's global `~/.claude/settings.json` and installs scripts in `~/.aspire/hooks`.
  Task 00 hit this and reverted both.

## Task 01 — monorepo foundation

- **`@eslint/js` is catalogued as `^10.0.1`, not `10.11.0`.** It is the one catalog entry that is
  a range: `@eslint/js` releases behind `eslint` itself, and `10.11.0` does not exist. It was
  added to the catalog at all because the flat config imports `js.configs.recommended`.
- **`tsx` is a root devDependency.** Every app will declare it too, but having it at the root is
  what let task 01 prove at runtime that `exports: "./src/index.ts"` resolves across packages.
- **Error codes live in `@mercatus/core` as `ERROR_CODES`; `@mercatus/contracts` derives
  `errorCodeSchema` from it.** BUILD-PLAN §6.0 puts the enum in `contracts/errors.ts`, and it is
  there — but derived, not retyped, because the classes that throw the codes are in core and two
  hand-maintained lists drift. `contracts` therefore depends on `core`; there is no cycle.
- **`MercatusError` carries a `logDetail` that `toEnvelope()` never serialises.** That is how S1
  is made mechanical: the generic code goes on the wire, the real reason goes in the log, and you
  cannot leak the second by forgetting.
- **The paged-result type is `PagedResult<T> = { items, total }`, and `normalisePageRequest`
  clamps rather than rejects** (default 50, max 200). A client asking for 10 000 rows is being
  optimistic, not hostile, and a 400 there buys nothing.
- **The stub token's audience claim is the type split.** `aud` is `staff` | `shopper` | `refresh`;
  `tid` (a tenant uuid) and `roles` appear on staff tokens only; a `shopper` token carrying `tid`
  is rejected by `verify()`. BH1 and BI2 are then properties of the token, not of a code path.
  Access tokens 900s (architecture.md §4's 15 minutes), refresh 86400s.
- **`AUTH_STUB_SECRET` must be at least 32 characters**, and the adapter throws at construction if
  it is not. jose refuses a sub-256-bit HS256 key, and boot is a better place to learn that than
  the first login.
- **`StubAuthAdapter` takes an optional `resolveTenantId(slug)` hook.** Without it, a stub
  authorization code must carry a tenant **uuid**; with it, a slug works. The stub cannot know the
  `tenants` table, and hard-coding a fake uuid per slug would put a lie in the auth path.
- **ESLint runs without type information** (`tseslint.configs.recommended`, not
  `recommendedTypeChecked`). The whole gate is under two seconds as a result. Revisit if a rule we
  actually want needs types; `--max-warnings 0` is already wired, which is the G1 half that
  matters.
- **`noUncheckedIndexedAccess` is on, `exactOptionalPropertyTypes` is off.** The first catches a
  real class of bug for the cost of a few guards; the second mostly generates ceremony around
  optional fields in a POC.
- **No package has a `build` script.** Packages export TypeScript source and are consumed by
  `tsx` / Vite / Next directly; only the three Fastify apps will produce a `dist/`, and only for
  their Dockerfiles. `turbo run build` exists and currently matches nothing.
- **`pnpm-workspace.yaml` carries `onlyBuiltDependencies: [esbuild]`** so `pnpm install` does not
  die on vitest's transitive build script, and a pnpm-written `minimumReleaseAgeExclude` block
  which is left alone.

## Task 02 — schemas, RLS and contracts

- **`DATABASE_SUPERUSER_URL` is added to the §8.2 environment contract.** Creating a role needs a
  connection that can create roles, and `DATABASE_ADMIN_URL` is `mercatus_owner`, which is
  deliberately `nocreaterole`. It defaults to `DATABASE_ADMIN_URL` when unset, so an Aspire-
  provisioned Postgres — where the admin connection *is* the superuser — needs no extra wiring.
- **`sql/02-rls.sql` is hand-authored rather than expressed with Drizzle's `pgPolicy`.**
  BUILD-PLAN §5.3 allows either. The grants have to live next to the policies to be reviewable in
  one place, `pgPolicy` cannot express them, and J1 forbids hand-editing a generated migration —
  so keeping `migrations/` generated and this file owned is the only arrangement where both halves
  are readable.
- **The control plane gets its own two roles, `mercatus_platform_owner` and
  `mercatus_platform_app`,** rather than reusing the data plane's. Roles are cluster-wide, so
  reusing `mercatus_app` would give a store process credentials that work against the control
  plane's database. `00-roles.sql` also revokes `connect` on the platform database from `public`,
  which makes CO3's boundary true at the database as well as in the Aspire model.
- **Role passwords are literals in `sql/00-roles.sql`** (`mercatus_owner_dev`, `mercatus_app_dev`,
  `mercatus_platform_owner_dev`, `mercatus_platform_app_dev`). Templating them would need a
  substitution step in the migrate script for a database that only ever exists on a laptop.
- **`order_counters` rows are created when a tenant is mirrored, not lazily at first checkout.**
  `takeOrderNumber` therefore treats zero rows as a bug and throws, per §5.2 — a lazy insert would
  make "no tenant context" indistinguishable from "first order ever", which is the one distinction
  that matters there.
- **`placeOrder` decrements stock with a conditional `update … where id = ? and stock >= qty`**
  rather than read-then-write. Two shoppers racing for the last unit both read 1; exactly one
  matches zero rows and gets the 409.
- **`products` carries `check (price_minor >= 0)` and `check (stock >= 0)`; `order_lines` carries
  `check (qty > 0)`.** Only the last is in BUILD-PLAN §5.2. Negative money and negative stock are
  the two states no code path should be able to reach, and a check constraint is cheaper than the
  test that would otherwise have to prove it.
- **Foreign keys are simple (`order_lines.product_id -> products.id`), not composite on
  `(tenant_id, id)`.** Postgres checks an FK as the table owner, so RLS does not constrain the
  reference itself — but the referencing *row* still has to satisfy its own `with check`, so no
  cross-tenant row can be created, and reading the referenced row still goes through that table's
  policy. Composite FKs would close a data-integrity gap, not a leak. Noted rather than built.
- **`ProductNotFoundError` and `OrderNotFoundError` added to `@mercatus/core`.** Both codes were
  already in `ERROR_CODES` with no class able to throw them.
- **`@mercatus/contracts` splits into `common.ts` / `store.ts` / `platform.ts`** beside the
  existing `errors.ts`, and PATCH bodies are `.partial().strict()` so an unknown key is a 400
  rather than a 200 that changed nothing.
- **Both db packages have a `test` script, and the leak suite skips loudly when no database URL is
  set.** Two of the four db-store suites need a live Postgres; the other two parse the migrations
  and grep the source, so `pnpm -r test` without a database still enforces "every new table has a
  policy" and "no application query filters by tenant".

## Task 03 — apps/store, the data plane API

- **Two variables added to the §8.2 contract: `BASE_HOST` (default `localtest.me`) and
  `LOG_LEVEL` (default `info`).** Host-based tenant resolution has to know which DNS suffix is
  ours before it can read a label as a tenant, and hard-coding `localtest.me` in core would make
  tier 2 a code change rather than configuration. `HOST` (bind address, default `127.0.0.1`) is
  also read, beside the `PORT` that §8.2 already names.
- **A candidate that disagrees with the deployment is a 403, not a switch.** §3.6 says
  deployment → host → path, first hit wins. Taken literally, a dedicated instance pinned to
  `zenith` would serve zenith's catalog at `/t/acme/products`. `resolveTenantCandidate` keeps the
  documented signature and `tenantCandidates` returns the whole list, so the auth hook can refuse
  a disagreement. Same rule as BI1, arriving through the deployment instead of a token.
- **Reserved host labels are `platform`, `id`, `identity`, `admin`, `bank`, `api`, `www`.**
  BUILD-PLAN §3.6 names four; the other three are infrastructure names a merchant slug must not be
  able to shadow.
- **The tenant context is carried on `request.tenantContext` and entered per handler through one
  helper, not established in a hook.** AsyncLocalStorage set inside an async Fastify hook does not
  reach the handler, and `enterWith()` can outlive a request on a keep-alive connection — which
  here would be a cross-tenant leak. So `inTenantTx(deps, req, fn)` wraps
  `runInTenant(ctx, () => withTenantTx(db, fn))`, one call at the top of each handler. A handler
  that forgets it throws `MissingTenantContextError` at the first query.
- **`PATCH /api/settings` is not implemented, and the store is the wrong place for it.** The app
  role has SELECT on `tenants` and nothing else, because that table has no RLS; granting UPDATE
  would open a cross-tenant write surface with no policy to scope it. Store name and branding are
  control-plane facts mirrored down (BV1), so the edit belongs on the platform API, which
  re-mirrors. `GET /api/settings` and `GET /api/licence` exist.
- **`/health` reports `{status, version, mode, tenant}`.** The §6.0 health shape is
  `{status, version}`; a data plane that cannot say which mode it is running and which tenant it
  is pinned to fails CE6, and responses are serialised through their Zod schema, so the extra
  fields had to be in the contract. Added as `storeHealthSchema` in `@mercatus/contracts`, beside
  `deleteResultSchema` for the DELETE reply.
- **`/_meta` reports the licence of the tenant the request names, and `active`/`healthy` when it
  names none.** A pooled process serves N merchants and has no single licence; it also shares a
  machine with the control plane, so "never polled" is its normal state rather than an outage.
  The degradation demo runs against a dedicated instance, where the deployment pins the tenant.
- **`turbo.json` now declares `env` on the `test` and `migrate` tasks.** Turbo passes a task only
  the variables its `env` list names, so `pnpm check` was running the live-database suites as
  skipped and still reporting success — 37 of db-store's 69 tests. Not a design decision so much
  as a trap that had to be closed before task 04 inherited it.
- **`@mercatus/core` now depends on fastify, @fastify/cors, @fastify/swagger, Scalar,
  fastify-type-provider-zod and zod.** BUILD-PLAN §6.0 puts `createServer` in core, and the
  composition helper is only worth having if it wires the whole set. No app registers those
  plugins itself.

## Task 04b — apps/fake-bank

- **The two HMAC canonical forms are the values joined by `|`, in a fixed order, hex-encoded
  HMAC-SHA256.** `apps/platform` must produce and verify exactly these:
  `request  = reference|amountMinor|currency|callbackUrl` (platform signs, fake-bank verifies) and
  `callback = providerRef|status|amountMinor|currency` (fake-bank signs, platform verifies).
  `amountMinor` is written as a base-10 integer, so there is no float formatting to disagree on.
  Deliberately the dumbest scheme that works: what is being exercised is "do both sides agree",
  not the scheme.
- **fake-bank's own Zod schemas live in `apps/fake-bank/src/contracts.ts`, not in
  `@mercatus/contracts`.** fake-bank is run-mode only and never ships (§6.3, CR1), while
  `@mercatus/contracts` is imported by everything that does. The one shape that crosses the
  boundary — the callback body — is imported *from* `@mercatus/contracts`
  (`paymentCallbackBodySchema`) and parsed before sending, so the contract that matters cannot
  drift.
- **`loadFakeBankConfig()` lives in `apps/fake-bank/src/config.ts`, not in
  `packages/core/src/config.ts`.** Same reason: a config loader for a service that must never be
  reachable from a published image does not belong in the package every app imports.
  `loadPlatformConfig()` beside `loadStoreConfig()` is still the right home for the platform's,
  and is left to whoever builds `apps/platform`.
- **fake-bank calls `createServer()` with no `auth` block at all.** It has no tenants and no
  tokens; the only thing it authenticates is an HMAC on a request body, which is a property of the
  payload rather than of the caller, so it belongs in the route. `AuthContextOptions` already
  documented this case.
- **The 401 for a bad request signature carries the canonical string fake-bank hashed, in
  `details`.** This is a deliberate exception to S1, which exists to stop auth-shaped endpoints
  being probed for accounts. There are no accounts here, the service never ships, and the
  canonical string is the one piece of information that turns "signature invalid" into a fix. It
  contains no secret and no digest.
- **A fifth internal status, `dropped`, beside the `created|paid|declined` the platform knows.**
  A dropped connection is not an outcome a real provider would ever report — we would only see the
  socket close — so it is fake-bank's own state and never appears in a callback.
- **`no-callback` leaves the payment `paid`.** The bank took the money and we were never told; our
  books and theirs disagree. That is the state a reconciliation job exists for, and being able to
  produce it on demand is the point of the behaviour.
- **The behaviour is chosen in three places with one default:** the body of
  `POST /pay/:id/complete`, then `?behaviour=` on that call, then `POST /payments?behaviour=` at
  creation, then `approve`. The query parameter at creation is what lets an automated
  buy-a-store test drive a failure without opening the page.
- **A settled payment answers 409 rather than settling again.** The platform's callback handler is
  already idempotent by `providerRef` (CK2), so a second settlement would test nothing a replayed
  callback does not.
- **The callback is awaited before the completion is answered.** A real provider fires it
  asynchronously; a fake driven from a shell script has to be deterministic, so after
  `curl …/complete` returns, `GET /payments/:id` already knows what the callback did.
- **`paymentUrl` is built from the request, not from a configured base URL**, so fake-bank reads
  no `FAKE_BANK_URL`. `trustProxy` is already on in `createServer`, so this stays correct behind
  Aspire and Traefik.
- **The `--mc-*` design tokens are inlined in `apps/fake-bank/src/page.ts`.**
  `packages/ui/src/tokens.css` does not exist yet and fake-bank is a server with no bundler, so it
  has no way to ship a workspace stylesheet. The names match BUILD-PLAN §7.1 exactly; when
  `tokens.css` lands, that `:root` block is the thing to delete.
- **The payment page's buttons post JSON with `fetch` rather than submitting a form.** Fastify does
  not parse `application/x-www-form-urlencoded` without `@fastify/formbody`, which is not in the
  catalog. One dependency avoided for four lines of script.

## Task 04a — apps/platform, the control plane

- **The signed licence is Ed25519, not an HMAC.** A dedicated store runs on a machine whose owner
  has root (CE5). A shared-secret licence would put a key that MINTS licences — for that tenant
  and every other — on that box, so the licensing mechanism itself would break CE1. Asymmetric
  means the instance holds only the public half: it can check a licence and it cannot write one.
  The public key is published at `GET /licence/jwks` for the instance to cache (CE4).
- **`exp` on the licence is the end of `valid_until`, not a short session lifetime.** The two
  clocks stay separate: the licence says what the merchant paid for, and the grace window for an
  unreachable control plane is computed in the data plane from `last_success_at` (CG2, CG3).
- **Three new environment variables, all in `apps/platform/src/config.ts`:**
  `LICENCE_SIGNING_KEY` (Ed25519 PKCS8 PEM; there is deliberately no `LICENCE_PUBLIC_KEY`,
  because the public half is derived and so cannot drift), `STORE_PLAN_PRICE_MINOR` (default
  49900) and `STORE_PLAN_CURRENCY` (default TRY). A store has one price and the POC has no
  pricing model; putting it in the environment beats a literal in a handler.
- **A development licence key is committed**, at `apps/platform/keys/dev-licence-private.pem`, and
  `loadPlatformConfig` refuses it under `NODE_ENV=production`. A key that changes at every boot
  would make a cached JWKS wrong after a restart, which is exactly the path task 10 depends on.
- **`PLATFORM_DATABASE_URL` is added to the §8.2 contract**, and to `turbo.json`'s `test` task.
  `pnpm check` runs every suite at once and the data-plane suites already own `DATABASE_URL` for
  the `store` database; one variable cannot be two databases. It falls back to `DATABASE_URL` when
  only the platform package is run. The `turbo.json` line is the only edit this task made outside
  `apps/platform` and `packages/db-platform`, and it was made because a variable turbo does not
  know about is a suite that skips while the run stays green (lessons/03).
- **`loadPlatformConfig()` lives in `apps/platform/src/config.ts` rather than in
  `packages/core/src/config.ts`,** which §8.2 names as its home. The reason is concurrency, not
  design: another agent was writing `apps/fake-bank` at the same moment, and two agents rewriting
  one shared file silently clobber each other. It depends on nothing in the app; moving it into
  core is a cut and a paste.
- **New wire shapes live in `apps/platform/src/schemas.ts` rather than in `@mercatus/contracts`,**
  for the same reason, and are written against the contracts primitives so the move is mechanical:
  `createTenantBodySchema`, `activateTenantBodySchema`, `signedLicenceSchema`, `jwksSchema`,
  `installationSchema`, `installationListSchema`, `devOperatorLoginBodySchema`. Task 08 should
  move them when it builds the console that consumes them.
- **The operator credential is a token with `aud: "operator"`, not a static admin secret.**
  `POST /dev/login/operator` mints an HS256 JWT under `AUTH_STUB_SECRET`, registered only when
  `AUTH_ADAPTER=stub`, exactly like the store's dev login. A merchant's `aud: "staff"` token is
  refused on every console route, so BH1 is a property of the token rather than of a code path,
  and the Identity phase replaces the minting without touching a route.
- **The platform calls `createServer()` with `auth: { adapter }` and no `tenants` or
  `deployment`.** It has tenants in a table but no tenancy in its requests: no RLS, no
  `app.tenant_id`, no per-request tenant decision. Handing the hook a `TenantDirectory` would make
  it try to resolve a tenant from the URL of `/tenants/acme`, which is the one place in the repo
  where a slug in a path is a query parameter rather than a claim about who is asking.
- **An instance token may read its own tenant and no other — 403 otherwise.** That is BI1 arriving
  through a credential instead of a route. An operator may read any tenant, and every such read is
  logged with the operator's subject (BH2).
- **`licences` gained an `id` column and `installations` a `licence_id`.** `heartbeatBodySchema`
  names a licence id and CE6 wants every data plane to report the licence it is running under;
  reusing `tenant_id` for that would collapse two identifiers and make "which licence is that box
  on" unanswerable after the first re-issue. `tenant_id` remains the primary key — still one
  licence per tenant.
- **The fake-bank HMAC canonical strings, now fixed on both sides:**
  request `reference|amountMinor|currency|callbackUrl`, callback
  `providerRef|status|amountMinor|currency`, lowercase hex HMAC-SHA256. Written independently by
  the two agents and identical; `apps/fake-bank/src/signing.ts` and
  `apps/platform/src/signature.ts` are the two copies.
- **`FAKE_BANK_HMAC_SECRET` must be at least 32 characters on the platform side too.** fake-bank's
  own config demands 32, so a shorter secret would boot here and fail there — a mismatch found at
  the first payment rather than at the first start.
- **The payment callback checks the amount against our own payment row, and answers 409 when they
  disagree.** A callback that verifies against its own signature but not against what we asked for
  is a bug in one of the two; accepting it silently would make the signature pointless.
- **A declined payment leaves the tenant `pending` with its slug and id intact**, and `/signup`
  with the same slug resumes that tenant rather than colliding (CK2). Everything the buyer typed
  survives the card being refused.
- **`POST /tenants/:slug/activate` exists beside the console's flip.** §6.1 names only
  `POST /tenants/:slug/licence`, which suspends and restores, but the Q13 split — signup creates,
  payment activates — is only worth having if there is a supported way to activate without a
  payment. Trials, internal demo stores and hand-onboarded merchants are that way. Flipping a
  `pending` tenant is a 409: there is nothing to suspend.
- **`GET /installations` is added to §6.1's list.** The heartbeat records a version and a licence
  id that nothing else could read, and `tenantSummarySchema.installation` does not carry the
  licence id. Without this endpoint "the heartbeat records it" is not observable.
- **`POST /payments/proxy` from §6.1 was NOT built.** Checkout in the data plane ends at
  "ordered" and moves no money, so there is nothing to proxy yet; building it now would be
  guessing at the shape. It is the only endpoint in §6.1 that is missing.

## Task 05 — aspire/AppHostA and the dev seed

- **The AppHost directory is `aspire/AppHostA`, not `aspire/control-plane`.** BUILD-PLAN §1 names
  the latter; the task brief and the architecture docs both talk about "AppHost A" and "AppHost B",
  so the directory now says what the docs say. B goes in `aspire/AppHostB`.
- **Traefik binds the fixed port 8080, not 8090.** §8.1 chose 8090 because `qbittorrent` held 8080
  when task 00 looked; it was free on this machine tonight, and the brief fixes 8080 so AppHost B
  can bind stable URLs. If a future run fails with `bind: address already in use`, qbittorrent is
  back and this is the line to change.
- **Two Postgres servers, `pg-platform` and `pg-store`, rather than one with two databases.**
  Lesson 02 proved one cluster works, but the control plane and the data plane are separate blast
  radii and a container each costs nothing on a laptop. It also makes the §8.1 boundary visible in
  the dashboard rather than only in a `revoke connect`.
- **Services are `AddExecutable(name, "node", dir, "--import", "tsx", ...)`, not
  `AddJavaScriptApp`.** `Aspire.Hosting.JavaScript@13.5.4` does exist, but `node` directly is one
  process with no package-manager detection to get wrong, and the brief blessed the fallback.
  Revisit when a Vite/Next resource needs dev-server handling.
- **Node endpoints are `isProxied: false`.** A DCP proxy binds loopback only, and Traefik reaches
  these services from inside a container over the docker host gateway. Consequence: the services
  bind `HOST=0.0.0.0`.
- **`apphost.run.json`'s `http` profile is first, and its ports are pinned** — dashboard 15230,
  OTLP 19071, resource service 20005. §8.1 said "template defaults", but `aspire new` randomises
  them per scaffold, so they are not a fixed set. Plain HTTP because the OTLP gRPC exporter would
  otherwise need Aspire's self-signed dev cert in Node's trust store. **AppHost B: 15240 / 19081 /
  20015.**
- **`ConnectionStrings__*` is wired but not read.** `WithReference` gives the dependency edge and
  the dashboard entry; `DATABASE_URL` is built separately as a `postgres://` URL for the **app
  role**, because the string Aspire injects is the superuser's and a superuser bypasses RLS (BE2).
- **The Postgres superuser password is pinned to a literal** rather than left to Aspire's
  generator, which may produce characters that are not URL-safe.
- **`dev-seed` seeds a dedicated tenant `zenith` and an unspent installation row**, in the new
  `packages/db-platform/src/seed-dedicated.ts`. `seed.ts` says zenith is not seeded because
  provisioning is a real operation (CK1) — still true of the product; `POST /installations` is
  untouched and task 10 exercises it. This exists so AppHost B has a token to present before
  anything is running that could issue one. Same rows, same sha256 hashing, fixed input:
  `mercatus-dev-bootstrap-token-for-zenith-001`.
- **`PLATFORM_DATABASE_ADMIN_URL ?? DATABASE_ADMIN_URL`** in db-platform's `migrate.ts`, `seed.ts`
  and `seed-dedicated.ts`, added to `turbo.json`'s `migrate` env list. One `dev-seed` process
  seeds two databases, and one variable cannot name both — the same fix task 04a made with
  `PLATFORM_DATABASE_URL`.
- **OpenTelemetry is a runtime preload, not an application import.**
  `packages/core/src/telemetry.ts` is loaded by the AppHost with `--import`, before the app's
  module graph evaluates, because instrumentation patches modules as they load and importing it
  from `index.ts` would be too late for `fastify` and `postgres` — silently, with an empty
  dashboard. No endpoint in the environment means it does nothing, so a hand-started service or a
  test dials nothing.
- **No fastify instrumentation.** `@opentelemetry/instrumentation-fastify` is deprecated in favour
  of `@fastify/otel`, a plugin every app would have to register, and all it adds is a span per
  hook. `instrumentation-http` + `instrumentation-pg` give the server span and the query under it.

## Task 06 — the cross-tenant leak suite

- **The leak suite owns its database.** `@testcontainers/postgresql` brings up `postgres:18.3` in
  a vitest `globalSetup` and runs the real init order (roles → drizzle migrate → RLS). BL1's
  failure mode is not a wrong suite, it is a suite that does not run: the previous shape read
  `DATABASE_URL` and `describe.runIf`'d itself away, so a green `pnpm test` on a machine with no
  Postgres proved nothing.
- **One container per package, not per file.** `fileParallelism: false` and
  `project.provide` / `inject`, so `order-number.test.ts` shares it. That test lost its
  `describe.runIf(hasDb)` too.
- **`MERCATUS_LEAK_SABOTAGE=<table>` is a committed test affordance, not scaffolding.** It swaps
  one table's isolation policy for `using (true) with check (true)` after the migrations. A leak
  suite that has never been seen to fail is not evidence, and the experiment has to be repeatable
  by the next person in one command rather than re-derived. It is also in `turbo.json`'s `test`
  env list so turbo cannot serve a cached green over a sabotaged run.
- **Sabotage by policy swap, never by `disable row level security`.** Leaving RLS enabled and
  forced keeps the coverage assertions green, so only the leak assertions redden — which is what
  identifies the assertions doing the work.
- **`cpu-features` and `ssh2` are answered `false` in `allowBuilds`.** They are dockerode's
  optional `ssh://` transport; this repo uses the local docker socket. First denied build scripts
  in the workspace — the previous entries are all `true`.
- **Testcontainers pins `postgres:18.3`, matching what the RLS behaviour was verified on.** A
  floating tag would make an RLS regression look like a flake.
- **`tenants` is in the suite even though it has no RLS**, asserted through grants instead:
  `mercatus_app` selects, and insert/update/delete each come back `permission denied` / 42501.
  BE4 is about checking each store separately, and "no policy" is not "no test".
