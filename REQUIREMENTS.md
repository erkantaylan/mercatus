# Requirements

What must exist on the machine before `pnpm install`. Versions are what the project was built and
verified against on 2026-09-22.

---

## Host tools

| | Required | Built against | Why |
|---|---|---|---|
| **Node.js** | ≥ 22.0.0 | 22.23.2 | `engines` in `package.json` |
| **pnpm** | 12.5.1 | 12.5.1 | pinned in `packageManager`; ships via corepack |
| **.NET SDK** | 10.0.x | 10.0.110 | the two Aspire AppHosts are single-file C# |
| **Aspire CLI** | ≥ 13.5.3 | 13.5.3 | AppHost SDK pinned to `Aspire.AppHost.Sdk@13.5.4` |
| **Docker** | ≥ 24 | 29.7.2 | must be usable **without sudo** |
| **Google Chrome** | any current | 151.0.7922.108 | Playwright runs `channel: 'chrome'`; no browser is downloaded |

Docker must run rootless or with the user in the `docker` group — the test suite and both AppHosts
start containers directly.

---

## Container images

Pulled automatically on first run. Nothing to install by hand.

| Image | Tag |
|---|---|
| `svhd/logto` | `1.43.0` |
| `traefik` | `v3.5` |
| `postgres` | whatever `Aspire.Hosting.PostgreSQL@13.5.4` resolves (18.x) |

Four Postgres containers run at once with both AppHosts up: `pg-platform`, `pg-store`, `pg-logto`
(AppHost A) and `pg-zenith` (AppHost B).

---

## Network

| | |
|---|---|
| **DNS** | `*.localtest.me` must resolve — it is a public record pointing at `127.0.0.1`. No `/etc/hosts` entry is needed, but name resolution must work |
| **Internet** | first run only, to pull images and packages |

### Ports that must be free

| Port | |
|---|---|
| `8080` | Traefik edge — every HTML surface of AppHost A |
| `4001` | platform API |
| `4002` | store API (pooled) |
| `4003` | store API (dedicated, AppHost B) |
| `4004` | fake-bank |
| `3001` | storefront (pooled) |
| `3002` | storefront (dedicated) |
| `5173` | merchant dashboard |
| `5174` | platform console |
| dynamic | Postgres instances and both Aspire dashboards, assigned at run time |

`3000` is deliberately unused.

---

## Pinned package versions

Installed by `pnpm install` — listed because every version in the workspace is declared once in
`pnpm-workspace.yaml` under `catalog:` and nowhere else. No package.json carries a version.

| Runtime | | Frontend | | Tooling | |
|---|---|---|---|---|---|
| fastify | 5.12.5 | react | 19.3.0 | typescript | 5.9.3 |
| @fastify/cors | 11.3.0 | react-dom | 19.3.0 | tsx | 4.23.15 |
| @fastify/swagger | 9.8.2 | next | 16.3.5 | turbo | 2.11.2 |
| @scalar/fastify-api-reference | 1.70.0 | vite | 8.3.0 | vitest | 5.0.1 |
| fastify-type-provider-zod | 7.0.0 | @vitejs/plugin-react | 6.1.1 | eslint | 10.11.0 |
| zod | 4.6.5 | @tanstack/react-router | 1.170.38 | typescript-eslint | 8.70.1 |
| drizzle-orm | 0.45.3 | @tanstack/router-plugin | 1.168.40 | drizzle-kit | 0.31.11 |
| postgres | 3.4.9 | @tanstack/react-query | 5.103.2 | @playwright/test | 1.63.0 |
| pino | 10.3.1 | | | | |
| jose | 6.2.12 | | | | |

OpenTelemetry moves as one set — `@opentelemetry/api` 1.9.1, `sdk-node`,
`exporter-trace-otlp-grpc` and `instrumentation-http` at 0.222.0, `instrumentation-pg` at 0.74.0.

Two settings in `pnpm-workspace.yaml` matter on a fresh machine: `playwright: false` stops the
browser download (system Chrome is used instead), and `onlyBuiltDependencies` lists `esbuild` and
`protobufjs` — pnpm refuses to install while a dependency has an unapproved build script.

---

## Not required

No Redis, no message broker, no job queue, no cloud account, no payment provider account, no CI
runner, no Kubernetes. Payments go through `fake-bank`, which is part of the repo.

---

## Check

```bash
node -v && pnpm -v && dotnet --version && aspire --version \
  && docker version --format '{{.Server.Version}}' && google-chrome --version \
  && getent hosts shop.localtest.me
```
