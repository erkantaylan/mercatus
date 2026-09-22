# 05 — aspire/AppHostA, Traefik, and OTel from Node

## The three Aspire errors that cost the most time, and their fixes

**1. A non-container resource cannot have `port == targetPort` on a proxied endpoint.**

```
System.InvalidOperationException: The endpoint 'http' for resource 'fake-bank' requested a proxy
(IsProxied is true). Non-container resources cannot be proxied when both TargetPort and Port are
specified with the same value.
```

- `WithHttpEndpoint(port: 4004, targetPort: 4004, env: "PORT")` on an `AddExecutable` → the
  AppHost exits **134** before anything starts.
- Fix: `isProxied: false`. Then the process binds the port itself and there is no DCP proxy.
- You want `isProxied: false` here anyway: **the DCP proxy binds `127.0.0.1` only**
  (`ss -ltnp` → `127.0.0.1:8080 users:(("dcp",...))`), so a container reaching the host over
  `host-gateway` cannot get through it. With `isProxied: false` and `HOST=0.0.0.0`, `ss` shows
  `0.0.0.0:4002 users:(("node",...))` and Traefik works.

**2. Traefik's own entrypoint is `:8080` and it collides with yours.**

```
command traefik error: error while building entryPoint traefik: building listener:
error opening listener: listen tcp :8080: bind: address already in use
```

- The container exits 1 about 8 seconds in; Aspire reports `Starting -> Exited` and nothing else.
- `--entrypoints.web.address=:8080` does **not** replace it. Add
  `--entrypoints.traefik.address=:8099` as well.
- `--ping=true` publishes `/ping` on that internal entrypoint, not on `web` — so it is not a
  usable health check unless you also move it. Health-checking `/health` through `web` is better
  anyway: it proves routing, the host gateway and the backend in one probe.

**3. An interpolated string in `WithEnvironment` binds to the `ReferenceExpression` overload.**

```
error CS0315: The type 'int' cannot be used as type parameter 'T' in
ReferenceExpression.ExpressionInterpolatedStringHandler.AppendFormatted<T>(T).
There is no boxing conversion from 'int' to IValueProvider.
```

- `.WithEnvironment("PLATFORM_URL", $"http://127.0.0.1:{PlatformPort}")` does not compile.
- Assign the interpolation to a `var` first and pass the variable.

## Aspire 13.5.4 API, verified by compiling and running

- `AddExecutable(name, command, workingDirectory, params string[] args)` — working directory is
  relative to the AppHost directory. `AddPostgres(name, userName, password)` takes
  `IResourceBuilder<ParameterResource>` for both;
  `builder.AddParameter("pg-password", "literal", secret: true)` compiles and works.
- **Pin the Postgres password.** The generated one is random and may contain characters that are
  not URL-safe, and every connection string in this repo is a `postgres://` URL.
- `ReferenceExpression.Create($"postgres://user:pw@{server.Resource.PrimaryEndpoint.Property(EndpointProperty.HostAndPort)}/db")`
  is how you build a URL for an endpoint whose port Aspire allocates. `HostAndPort` resolves to
  `localhost:<random host port>` for an executable consuming a container's endpoint.
- Also present and working: `WithOtlpExporter()`, `WithHttpHealthCheck(path, endpointName:)`,
  `WithContainerRuntimeArgs(...)`, `WithBindMount(src, dest, isReadOnly:)`,
  `WaitFor` / `WaitForCompletion`, `builder.ExecutionContext.IsRunMode`.
- `AddDatabase("db-store", "store")` **does create the database.** No `WithCreationScript`, no
  `POSTGRES_DB` env var needed.
- **`Aspire.Hosting.JavaScript@13.5.4` does exist** (`dotnet package search` confirms it; lesson
  00 was right and `Aspire.Hosting.NodeJs` is the stale one). It was **not used** —
  `AddExecutable` with `node` is one process with no package-manager detection to get wrong.
  Revisit it if a Vite/Next resource needs the dev-server handling.

## `dotnet build apphost.cs` is the fast loop

- A file-based AppHost compiles with `dotnet build apphost.cs` in ~2s warm. Use it between edits;
  `aspire run` takes ~10s to reach the first compile error and leaves containers behind on some
  failures.
- `dotnet package search <name> --take 5` answers "does this package exist" without a project.

## What Aspire actually injects into an executable

Read from `/proc/<pid>/environ` of a running `store-pooled`:

```
ConnectionStrings__db-store=Host=localhost;Port=45845;Username=postgres;Password=...;Database=store
DB_STORE_URI=postgresql://postgres:...@localhost:45845/store
DB_STORE_HOST=localhost   DB_STORE_PORT=45845   DB_STORE_JDBCCONNECTIONSTRING=jdbc:...
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:19071
OTEL_EXPORTER_OTLP_PROTOCOL=grpc
OTEL_EXPORTER_OTLP_HEADERS=x-otlp-api-key=<per-run>
OTEL_SERVICE_NAME=store-pooled
OTEL_BSP_SCHEDULE_DELAY=1000   OTEL_METRIC_EXPORT_INTERVAL=1000   OTEL_TRACES_SAMPLER=always_on
```

- `ConnectionStrings__db-store` is **ADO format**, not a URL — a Node driver will not take it.
  `DB_STORE_URI` *is* a URL but it is the **superuser's**, which bypasses RLS (BE2). Build the
  app-role URL in the AppHost; use `WithReference` only for the dependency edge and the
  dashboard's benefit.
- Bracket access in TypeScript: `process.env['ConnectionStrings__db-store']`, because the dash is
  not a valid identifier.

## OpenTelemetry from Node into the Aspire dashboard

- **The SDK must start before the app's module graph is evaluated**, or `http` and `pg` are never
  patched and the dashboard silently stays empty. Importing it from `index.ts` is too late.
  What works:

  ```
  node --import tsx --import ../../packages/core/src/telemetry.ts src/index.ts
  ```

  tsx first so the second preload can be a `.ts` file; `--import` specifiers resolve relative to
  cwd. One process, no child (`node --import tsx file.ts` does not fork — verified with `ps`).
- **The default `https` launch profile breaks the exporter.** Aspire's OTLP endpoint is then
  `https://localhost:21177` with a self-signed dev cert, and `@grpc/grpc-js` will not trust it.
  Making the **`http` profile first in `apphost.run.json`** (it already carries
  `ASPIRE_ALLOW_UNSECURED_TRANSPORT=true`) gives `http://localhost:19071`, which the gRPC
  exporter opens insecurely with no extra configuration.
- `aspire run` picks the **first** profile in `apphost.run.json`. The `aspire new` template
  randomises these ports per scaffold, so "template defaults" is not a fixed set of numbers —
  pin them if two AppHosts must coexist.
- **How to prove traces actually land**, without a browser: a wrong `x-otlp-api-key` against the
  same endpoint gives `16 UNAUTHENTICATED: Received HTTP status code 401`. So if the real
  services log **no** exporter error, their exports returned OK and the dashboard ingested them.
  A bogus *endpoint* gives `14 UNAVAILABLE: ... connect ECONNREFUSED`. Both are useful controls;
  set `diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN)` or you see neither.
- `@opentelemetry/instrumentation-fastify@0.57.0` is **deprecated** ("in favour of `@fastify/otel`,
  maintained by the Fastify authors"). Skipped — `instrumentation-http` already produces the
  server span and `instrumentation-pg` the query under it.
- Versions that install and work together: `@opentelemetry/api` 1.9.1, `sdk-node` /
  `exporter-trace-otlp-grpc` / `instrumentation-http` all **0.222.0**, `instrumentation-pg`
  **0.74.0**. The 0.x ones move as a set.

## pnpm 12, again

- `@opentelemetry/exporter-trace-otlp-grpc` → `@grpc/grpc-js` → **`protobufjs`**, which has a
  postinstall script, so the install fails fatally exactly as lesson 01 describes:
  `ERR_PNPM_IGNORED_BUILDS × installing dependencies ╰─▶ Ignored build scripts: protobufjs@7.6.6`.
- Fix **without** `pnpm approve-builds` (which rewrites `pnpm-workspace.yaml`): add `protobufjs`
  to both `allowBuilds:` and `onlyBuiltDependencies:` by hand.
- Careful: a failed install **already wrote** `protobufjs: set this to true or false` into
  `allowBuilds:`. Adding your own line then gives
  `duplicate mapping key: protobufjs` and the next install fails on YAML. Read the file after
  every failed install.

## localtest.me and curl

- `getent hosts acme.localtest.me` returns **`::1` only**, but the AppHost binds IPv4. `curl`
  falls back and reports `via 127.0.0.1`, so plain `curl http://acme.localtest.me:8080/...`
  works. No `--resolve`, no `-4`, no `/etc/hosts`.

## Ports on this machine, 2026-09-22

- **8080 was free**; `qbittorrent` was not running. Lesson 00 and BUILD-PLAN §8.1 say it is taken
  — that was true then, not now. AppHost A uses 8080 as the task brief requires. If a future run
  dies with `bind: address already in use` on 8080, qbittorrent is back.
- Taken and left alone: 3000 (`livemd`), 7070, 8778 (`chess-trainer`), 9100, 631, 20241.
