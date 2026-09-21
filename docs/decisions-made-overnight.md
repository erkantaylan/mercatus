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
