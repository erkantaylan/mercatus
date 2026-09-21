# 00 — recon and build plan

## Toolchain, as verified 2026-09-22

- node `v22.23.2` (nvm), dotnet SDK `10.0.110`, aspire CLI `13.5.3`, docker `29.7.2`.
- `corepack enable && corepack prepare pnpm@latest --activate` → **pnpm 12.5.1**, installed into
  `~/.nvm/versions/node/v22.23.2/bin/pnpm`. It is on PATH in a fresh login shell; no profile edit
  needed. Do not re-run it.

## Ports actually taken on this machine

- `*:3000` — `livemd`. `*:8080` — **`qbittorrent`**. Also busy: 7070, 9100, 8778, 631, 20241.
- **The brief says Traefik 8080. It is not free.** The plan uses **8090**.
- Free and assigned: 3001, 3002, 4001–4004, 5173, 5174, 5175, 8090.

## `aspire new` writes to your Claude Code config

- Running `aspire new` **without `--suppress-agent-init`** appends a `PostToolUse` hook to
  `~/.claude/settings.json` pointing at `~/.aspire/hooks/track-telemetry.sh`, and creates that
  directory. It says "Installed Aspire agent telemetry hooks for: Claude Code" in passing.
- Always: `aspire new … --non-interactive --nologo --suppress-agent-init`, and
  `ASPIRE_CLI_TELEMETRY_OPTOUT=true` in the environment.
- Task 00 reverted the hook and removed `~/.aspire/hooks`. If you see a `hooks` block in
  `~/.claude/settings.json` referencing `.aspire`, something ran `aspire new` without the flag.

## `aspire new` gotchas

- `--language C#` fails; the accepted value is **`csharp`**.
- `--output <dir>` requires the directory to be **empty**. Redirecting the command's own log into
  that directory makes it non-empty and the command fails. Write logs elsewhere.
- `aspire-empty` in 13.5.3 produces a **single-file `apphost.cs`** (`#:sdk Aspire.AppHost.Sdk@13.5.4`)
  plus `apphost.run.json`, `aspire.config.json`, `.vscode/`. There is **no `.csproj`**.
  Add packages with `#:package Aspire.Hosting.PostgreSQL@13.*` lines at the top of `apphost.cs`.

## Aspire run / stop

- `aspire run --detach --non-interactive --nologo --format Json` prints
  `{appHostPath, appHostPid, cliPid, dashboardUrl, logFile}` and returns. **Without `--detach` it
  blocks forever.**
- `aspire stop` (from the AppHost directory) stops the host **and its containers**. Verified:
  `docker ps` was clean afterwards, nothing leaked.
- First run pulls `postgres:18.3` and restores NuGet packages — allow several minutes. After that
  a Postgres resource is up ~10s after the command returns.
- `AddPostgres` binds a **random** host port to `127.0.0.1` (saw 32768) and generates a random
  superuser password. Get it with:
  `docker inspect <container> --format '{{range .Config.Env}}{{println .}}{{end}}' | grep POSTGRES_PASSWORD`
- Two AppHosts on one machine collide on the dashboard/OTLP/resource-service ports baked into
  `apphost.run.json`. Edit the second one's before first run.

## Node hosting integration

- **`Aspire.Hosting.NodeJs` is stale at 9.5.2.** The one that matches Aspire 13.5.x is
  **`Aspire.Hosting.JavaScript` 13.5.4**, and its extension methods are
  `AddJavaScriptApp(builder, name, appDirectory, runScriptName)`, `AddNodeApp`, `AddViteApp`,
  `AddNextJsApp`, `AddBunApp`, plus `WithViteConfig(path)`.

## Postgres RLS — the two things that will cost you an hour

Verified against `postgres:18.3`.

1. **`current_setting('app.tenant_id', true)` returns `''`, not NULL, once the session has ever
   had the GUC set** — `SET LOCAL` reverts it to the empty string at commit, for the rest of the
   session. A policy casting that straight to uuid then fails with
   `ERROR: invalid input syntax for type uuid: ""` on any query outside tenant context, and only
   on connections that previously served one — so it is intermittent under a pool.
   Always: `nullif(current_setting('app.tenant_id', true), '')::uuid`. Then no context = 0 rows.
2. **`SET LOCAL app.tenant_id = $1` is not valid SQL** — `SET` takes no bind parameters. Use
   `select set_config('app.tenant_id', $1, true)`, which is the same thing as a function call.
   Verified it drives the policy correctly from a prepared statement.

Also confirmed: `with check` blocks a cross-tenant insert from inside a correctly-scoped
transaction; a **superuser bypasses RLS even with `force row level security`**, so the runtime
role must be a plain `LOGIN NOBYPASSRLS` role, not `postgres`.

## npm versions, 2026-09-22

- `typescript@latest` is **7.0.2**. `typescript-eslint@8.70.1` peers on
  `typescript >=4.8.4 <6.1.0`. **Pin `typescript@5.9.3`** or linting breaks at install.
- `@types/node@latest` is 26.x — pin `^22` to match the runtime.
- Others resolved: fastify 5.12.5, zod 4.6.5, drizzle-orm 0.45.3, drizzle-kit 0.31.11,
  tsx 4.23.15, vitest 5.0.1, turbo 2.11.2, next 16.3.5, react 19.3.0, vite 8.3.0,
  @vitejs/plugin-react 6.1.1, @tanstack/react-router 1.170.38, @tanstack/router-plugin 1.168.40,
  @tanstack/react-query 5.103.2, postgres 3.4.9, pino 10.3.1, jose 6.2.12,
  fastify-type-provider-zod 7.0.0, @fastify/swagger 9.8.2, @fastify/cors 11.3.0,
  @scalar/fastify-api-reference 1.70.0, eslint 10.11.0.

## Machine hygiene

- There is a long-running unrelated container `chess-trainer` on 127.0.0.1:8778. **Leave it
  alone.** `docker ps` should show exactly it and nothing else when you finish.
