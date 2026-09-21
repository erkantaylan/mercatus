# 00 — recon and build plan

**Status:** done
**Gate:** `pnpm -v` → `12.5.1`, and `docs/BUILD-PLAN.md` exists with every section filled.
Additionally executed, beyond the stated gate: `aspire run --detach` started a real AppHost with a
Postgres container, RLS isolation was proven against it with SQL, and `aspire stop` cleaned up.

## What I built

No application code, as instructed.

- `diary/README.md`, `lessons/README.md` — the conventions for everyone after me.
- `docs/BUILD-PLAN.md` — ~960 lines. Layout, package names, the pinned version catalog, the
  tenant-context mechanism down to the SQL, the auth adapter interface in full, both database
  schemas column by column, every endpoint, every front-end route, ports, the environment variable
  contract, both AppHosts, the leak suite, and a twelve-task sequence each with an executable gate.
- `docs/decisions-made-overnight.md` — created, with task 00's decisions.

## What I verified by running it

- Toolchain: node 22.23.2, dotnet 10.0.110, aspire 13.5.3, docker 29.7.2, pnpm 12.5.1 (installed
  by corepack, persists in a fresh login shell).
- `aspire new aspire-empty --language csharp` produces a single-file `apphost.cs`, no `.csproj`.
- `aspire run --detach` → Postgres 18.3 container up; `aspire stop` → container gone, `docker ps`
  back to just the unrelated `chess-trainer`.
- Postgres RLS with `set_config('app.tenant_id', $1, true)`: tenant A sees only A, a cross-tenant
  insert is rejected by `with check`, and with the `nullif` guard a query with no tenant context
  returns zero rows instead of raising.
- `Aspire.Hosting.JavaScript@13.5.4` is the current Node integration and exposes
  `AddJavaScriptApp` / `AddViteApp` / `AddNextJsApp`.

## What the next agent needs to know

1. **Read `lessons/00-recon-and-build-plan.md` first.** It has the three things that will
   otherwise cost time: the `nullif` in the RLS policy, `set_config` instead of `SET LOCAL`, and
   `typescript@5.9.3` rather than `latest`.
2. **Traefik is on 8090, not 8080** — `qbittorrent` holds 8080 here.
3. **Always pass `--suppress-agent-init` to `aspire new`.** I did not, and it wrote a
   `PostToolUse` hook into the user's global `~/.claude/settings.json` and created
   `~/.aspire/hooks/`. I removed both and restored the file; verify it is still clean if you run
   `aspire new`.
4. Task 01 is the workspace skeleton. Its gate is `pnpm install && pnpm turbo run typecheck lint`
   exiting 0. Build the catalog in `pnpm-workspace.yaml` exactly as §2 of the plan lists it.

## State left behind

- Repository: docs and conventions only. **No `package.json`, no `node_modules`, no code.**
- No containers running from this task. No AppHost running. No ports bound.
- `~/.claude/settings.json` restored to its pre-task content; `~/.aspire/hooks/` removed.
- Probe scaffolding lives in the session scratchpad, outside the repository.
