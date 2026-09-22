# 05 — aspire/AppHostA and the dev seed

## What exists now

One command brings the whole control plane and the pooled data plane up:

```bash
cd aspire/AppHostA && aspire run --detach --non-interactive --nologo --format Json
```

`aspire/AppHostA/apphost.cs` — a single-file C# AppHost (`#:sdk Aspire.AppHost.Sdk@13.5.4`,
`#:package Aspire.Hosting.PostgreSQL@13.5.4`). Nine resources:

| Resource | What it is |
|---|---|
| `pg-platform` → `db-platform` | Postgres 18.3, database `platform`. Default container lifetime |
| `pg-store` → `db-store` | Postgres 18.3, database `store`. Default container lifetime |
| `migrate-platform` | `pnpm --filter @mercatus/db-platform migrate` |
| `migrate-store` | `pnpm --filter @mercatus/db-store migrate` |
| `dev-seed` | **run mode only** (`builder.ExecutionContext.IsRunMode`). `pnpm run dev-seed` |
| `platform` | `apps/platform` on 4001 |
| `store-pooled` | `apps/store` on 4002, `DEPLOYMENT_MODE=pooled` |
| `fake-bank` | `apps/fake-bank` on 4004, `MERCATUS_ALLOW_FAKE_BANK=1` |
| `traefik` | `traefik:v3.5` on the **fixed** port 8080, routing `*.localtest.me` |

Two Postgres **servers**, not one with two databases: the control plane and the data plane are
separate blast radii, and one container each costs nothing on a laptop.

### Connection strings

Every service gets `WithReference(db)` + `WaitFor(db)`, so Aspire injects
`ConnectionStrings__db-store` / `ConnectionStrings__db-platform` (ADO format) and the dependency
shows in the dashboard. **Nothing reads those.** `DATABASE_URL` is built separately in the
AppHost as a `postgres://` URL for the **app role** — `mercatus_app` / `mercatus_platform_app`,
both `NOBYPASSRLS` — because the connection string Aspire hands out is the superuser's, and a
superuser bypasses RLS even with `force row level security` (BE2, lesson 02). The owner and
superuser URLs exist only on the migrate and seed resources.

### The dev seed

`dev-seed` runs the new root script `pnpm run dev-seed`, which is three existing package scripts
in order:

1. `@mercatus/db-platform seed` — tenants `acme` + `borg`, pooled, active, licensed
2. `@mercatus/db-platform seed:dedicated` — **new**, `packages/db-platform/src/seed-dedicated.ts`
3. `@mercatus/db-store seed` — the same two tenant ids mirrored, with 4 + 3 products

`seed-dedicated.ts` adds tenant `zenith` (tier `dedicated`, status `active`, licensed) and one
**unspent installation row**, its bootstrap token stored only as a sha256 hash exactly as
`POST /installations` stores it. The token is a fixed development literal,
`mercatus-dev-bootstrap-token-for-zenith-001`, printed on every run. **Task 10 presents it to
`POST /installations/register`** to get AppHost B's instance token. Re-running the seed never
issues a second token and never resurrects a spent one.

One process seeds two databases, so `db-platform`'s `migrate.ts`, `seed.ts` and `seed-dedicated.ts`
now read `PLATFORM_DATABASE_ADMIN_URL ?? DATABASE_ADMIN_URL` — the same shape as the
`PLATFORM_DATABASE_URL` fallback task 04a added for the same reason. Added to `turbo.json`'s
`migrate` env list.

### Telemetry

`packages/core/src/telemetry.ts` — new, and **imported by no application**. The AppHost preloads
it into every Node service:

```
node --import tsx --import ../../packages/core/src/telemetry.ts src/index.ts
```

tsx first so the second preload can be TypeScript; telemetry second so the SDK patches `http` and
`pg` before the application graph evaluates. It reads Aspire's `OTEL_*` variables and configures
nothing itself. No endpoint → no-op, so a service started by hand for a test dials nothing.

New dependencies on `@mercatus/core`, all catalogued: `@opentelemetry/api` 1.9.1, `sdk-node`,
`exporter-trace-otlp-grpc`, `instrumentation-http` (all 0.222.0), `instrumentation-pg` 0.74.0.
No fastify instrumentation — `@opentelemetry/instrumentation-fastify` is deprecated in favour of
`@fastify/otel`, and http + pg already give the server span and the query under it.

### Traefik

`aspire/AppHostA/traefik/dynamic.yml`, bind-mounted read-only at `/etc/traefik/dynamic`. Three
routers: `platform.localtest.me` and `bank.localtest.me` at priority 100, and everything else to
`store-pooled` at priority 1. Backends are `http://host.docker.internal:400x`; the AppHost adds
`--add-host=host.docker.internal:host-gateway` and the services bind `HOST=0.0.0.0`, because
Traefik reaches them from inside a container.

**Port 8080, not 8090.** The task brief fixes it at 8080 so AppHost B can bind stable URLs, and
8080 was free on this machine. `BUILD-PLAN.md` §8.1 says 8090 because `qbittorrent` held 8080
when task 00 looked. Recorded in `decisions-made-overnight.md`.

`apphost.run.json` was rewritten: the `http` profile is first (so it is the one `aspire run`
picks), the dashboard is on 15230, OTLP on **19071**, resource service on **20005**. Plain HTTP
is deliberate — the OTLP gRPC exporter would otherwise need Aspire's self-signed dev cert in
Node's trust store. **AppHost B must use 15240 / 19081 / 20015** (BUILD-PLAN §8.1) or the two
collide.

## The gate

Full output in `lessons/`-adjacent form below; the substance:

```
== waiting for health ==
  t=10s platform=200 store=200 fake-bank=200 traefik:8080=200

-- GET http://acme.localtest.me:8080/t/acme/products
total: 4
   ACM-001 | Anvil, 50kg | 249900 TRY | stock 12
   ACM-004 | Giant Rubber Band | 12900 TRY | stock 100
   ACM-003 | Portable Hole | 44900 TRY | stock 30
   ACM-002 | Rocket Skates | 89900 TRY | stock 5
-- GET http://borg.localtest.me:8080/t/borg/products
total: 3
   BRG-001 | Assimilation Jacket | 159900 TRY | stock 8
   BRG-003 | Ocular Implant | 74900 TRY | stock 20
   BRG-002 | Regeneration Alcove | 999900 TRY | stock 2

== the dev seed, as the control plane sees it ==
tenants: 3
   zenith | dedicated | active | installation: yes
   acme | pooled | active | installation: no
   borg | pooled | active | installation: no

== OpenTelemetry ==
  OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:19071
  OTEL_EXPORTER_OTLP_PROTOCOL=grpc
  OTEL_SERVICE_NAME=store-pooled
exporter connection to the dashboard's OTLP endpoint:
  ESTAB 127.0.0.1:60464  127.0.0.1:19071  users:(("node",pid=135823,fd=23))
OTLP export errors logged by the services (0 = every batch was accepted): 0
same exporter, deliberately wrong x-otlp-api-key, for contrast:
  "16 UNAUTHENTICATED: Received HTTP status code 401"

== aspire stop ==  ✅ apphost.cs stopped successfully.
== docker after == chess-trainer        (the pre-existing unrelated container, untouched)
== stray node processes == (none)
```

The wrong-key probe is the control. Aspire's dashboard answers a bad `x-otlp-api-key` with
`16 UNAUTHENTICATED`, so "the real services log no export error" means their gRPC exports
returned OK — i.e. the dashboard ingested the spans. The trace **page** was not opened in a
browser; that is the one part of "traces appear in the dashboard" taken on the wire's word rather
than seen.

`pnpm check` was also run against the two Aspire-provisioned databases: **23/23 tasks, 69 + 22 +
17 + tests passing, nothing skipped.** That doubles as proof the AppHost's role wiring matches
what the suites expect.

## State left behind

- Nothing running. `docker ps` shows only the pre-existing `chess-trainer`.
- No repo file outside `aspire/`, `packages/core/src/telemetry.ts`,
  `packages/db-platform/src/seed-dedicated.ts` and the small edits listed above was touched.
- `~/.claude/settings.json` was **not** modified — `aspire new` was run with
  `--suppress-agent-init` and `~/.aspire/hooks` does not exist.

## What the next agent needs to know

- **Start it with `aspire run --detach` from `aspire/AppHostA`, stop it with `aspire stop` from
  the same directory.** Without `--detach` it blocks forever. `aspire stop` takes the containers
  with it; verified clean twice.
- The dashboard is **http://localhost:15230** and it prints a one-time login token on each run.
- **Task 10 (AppHost B)**: the bootstrap token is `mercatus-dev-bootstrap-token-for-zenith-001`,
  the tenant is `zenith`, and B's `apphost.run.json` must use 15240 / 19081 / 20015.
- **Task 06/07/08 (the front ends)**: add them to `apphost.cs` with the same `Node(...)` helper —
  it already does the endpoint, the OTLP preload and the health check. A Vite/Next app needs a
  different run command, so it will need its own helper rather than that one.
- Adding a service to the edge is two entries in `aspire/AppHostA/traefik/dynamic.yml` and
  nothing else; the file is watched, so an edit does not need a restart.
