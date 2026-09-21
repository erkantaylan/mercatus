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
