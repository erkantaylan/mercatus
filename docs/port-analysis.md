> **Archived 2026-09-22.** This document analysed rewriting a subset of the .NET Mercury
> codebase in TypeScript. The project has since become a greenfield, multi-tenant commerce POC —
> see [`../README.md`](../README.md). It is kept because its labelled paragraphs (**A**–**AR**)
> are still referenced elsewhere, and because the stack reasoning in **E**–**J**, **X** and
> **AD**–**AH** still holds. Treat every scope, line-count and sequencing claim as history.

# mercatus — port analysis (archived)

A stack design for rewriting **part of** Mercury in TypeScript. Thinking-process document —
nothing is committed to, and no code exists yet.

## Scope

| In | Out |
|---|---|
| **Identity** — a configured Logto container, not code we write (`CD1`) | Vpn API |
| **Store** API | Payment API |
| **Admin panel** (portal subset) | Medicine API |
| **Storefront** (existing Next.js) | DownloadHelper API |
| | Relay / Bridge device hubs |
| | Hangfire |

Four deployables, two databases. Everything below is scoped to that.

> **Status, 2026-09-22.** The direction has moved on from this document. **Q5** is answered — the
> dropped services go away entirely, there are no surviving .NET consumers — so this is no longer
> a scoped *port* but a **greenfield, multi-tenant POC influenced by Mercury**, with a control
> plane / data plane split and BYOC as a tier. What that means in practice:
>
> - **`apps/identity` does not exist.** Identity is a configured Logto container (`CZ`), so the
>   `jti` contract, the internal-key scheme and the claim shapes are free — nothing downstream
>   pins them any more.
> - **Q8 is resolved** — see the open questions below.
> - Current design lives in [`docs/architecture.md`](./docs/architecture.md) (service graphs) and
>   [`docs/dos-and-donts.md`](./docs/dos-and-donts.md) (rules).
>
> Sections below still hold wherever they describe the *stack* — Fastify, Drizzle, Aspire,
> TanStack, testing, CI. Treat the Store/Identity **porting** framing as superseded.

---

## Contents

1. [What the scope cut removed](#what-the-scope-cut-removed)
2. [What's actually left](#whats-actually-left)
3. [The framing](#the-framing)
4. [Foundation](#foundation)
5. [The two API services](#the-two-api-services)
6. [Data](#data)
7. [Scheduled work — the Hangfire question](#scheduled-work--the-hangfire-question)
8. [Realtime](#realtime)
9. [Edge and orchestration — Aspire stays](#edge-and-orchestration--aspire-stays)
10. [Observability and auth](#observability-and-auth)
11. [The admin panel](#the-admin-panel)
12. [The storefront](#the-storefront)
13. [Testing and CI](#testing-and-ci)
14. [Full stack table](#full-stack-table)
15. [How I'd sequence it](#how-id-sequence-it)
16. [Open questions](#open-questions)

Paragraph labels (**A**, **B**, …) and question numbers (**Q1**, **Q2**, …) are stable across
revisions: a label always points at the same claim, and a claim that gets withdrawn keeps its
label with a note rather than being renumbered.

---

## What the scope cut removed

Dropping VPN, Payment, Medicine, DownloadHelper, the device relay and Hangfire doesn't just shrink
the work — it deletes the parts of the design that were *hard*. Every one of the original
"you'll miss .NET here" items belonged to a service that is now out of scope.

| Label | Original claim | Status after the cut |
|---|---|---|
| **L** | pg-boss replaces Hangfire + eight `BackgroundService` daemons | **Withdrawn.** All eight daemons (`PaymentReconciliation`, `PaymentRecheck`, `PaymentNotify`, `Provisioning`, `VpnServerDoctor`, `VpnPoolMaintenance`, `IlkbyteBillingSync`, `DrugImport`) live in dropped services. Store has *no* `BackgroundService` at all. See **AI**. |
| **M**, **N** | Socket.IO for the device relay; the .NET agent's transport has to change | **Withdrawn.** `RelayHub` / `BridgeHub` are device-side and out of scope. Only `StoreHub` survives — see **AS**. |
| **T** | Rebuild ASP.NET Data Protection by hand for the key ring | **Withdrawn.** The key ring protected encrypted *merchant* credentials. Payment is out. |
| **Z** | SOAP (`System.ServiceModel`) and XML-DSig are the two genuine losses ⚠️ | **Withdrawn.** SOAP was Medicine; XML-DSig was the bank. Both out. `fake-bank` is out with them. |
| — | SSH.NET → `ssh2` for VPN provisioning | **Withdrawn.** VPN is out. |
| **P**, **AD**–**AH** | Aspire stays; Node apps are first-class resources | **Unchanged**, and now cheaper — 2 databases and 4 resources instead of 7 and 10. |
| **AB**, **AC** | Sequencing and the "don't rewrite" verdict | **Revised** — see **AQ** and **AR**. |
| **Q1** | Is the relay device agent .NET? | **Withdrawn by scope.** |

**AI.** Net effect on infrastructure: the design loses a job queue, an SSH client, an XML signing
library, a SOAP client and a key-ring implementation, and gains nothing. What's left is Postgres
and Node. That is the whole dependency list.

---

## What's actually left

Measured on `develop` @ `c7f4e009`, `.cs` line counts including migrations:

| In scope | Files | Lines |
|---|---:|---:|
| `Mercury.Store.Api` | 829 | 124,985 |
| `Mercury.Portal.Web.V5` (+29k Razor) | 321 | 44,708 |
| `Mercury.Identity.Api` | 104 | 12,729 |
| `Mercury.Core` (shared kernel) | 77 | 3,392 |
| `Mercury.Gateway` | 4 | 212 |
| `Alternet.Mercury.Store` (Next.js) | — | already TypeScript |
| **Total** | | **~186k** |

**AJ.** Store is **67% of everything in scope**. Identity is 7%. Any plan that treats them as two
comparable services is wrong: this is a Store rewrite with an auth service attached, and the
schedule should say so.

The admin panel shrinks with the services it fronted — 21 areas / 140 pages becomes 13 areas /
~93 pages:

| Keep | Pages | | Drop | Pages |
|---|---:|---|---|---:|
| Invoice | 35 | | Test | 8 |
| Admin | 31 | | CrossSale | 8 |
| Customer | 9 | | Vpn | 6 |
| Td (support tasks) | 6 | | Medicine | 6 |
| Order | 2 | | Relay | 6 |
| Account | 2 | | DownloadHelper | 5 |
| Sms | 2 | | Bridge | 1 |
| Panel, Support, Feedback, Profile, Raporlar, Home | 6 | | Import ❓ | 4 |
| **Total** | **~93** | | **Total** | **~44** |

**AK.** Two areas — **Invoice (35) and Admin (31)** — are two thirds of the remaining panel.
Whatever the portal plan is, it is mostly an invoicing plan. (`Import` is marked ❓ because it may
be drug-import tooling, which would leave with Medicine — worth confirming, see **Q7**.)

---

## The framing

**A.** A TS rewrite here is not a performance or productivity play — .NET 10 beats Node on both.
It's a **single-language play**, and the scope cut sharpens it: the four things left in scope are
exactly the four that share a customer, a session and a catalog. Today the panel's
`Requests/Apis/**` layer exists only because C# can't share types with the Next.js storefront, and
the storefront talks to a gateway it has no contract with. One language collapses that: DB schema
→ API → OpenAPI → *both* front ends, type-checked in one `tsc` run.

**AL.** And the honest counterweight, which the scope cut does **not** remove: Store is 125k lines
of behaviour that already survived production. Nothing in this document makes that smaller.

---

## Foundation

**B.** Node LTS (24/26 line), TypeScript strict, ESM only. Node runs `.ts` directly for the dev
loop; build prod images with **tsdown**. Skip Bun for the services.

**C.** **pnpm workspaces + Turborepo.** `Directory.Packages.props` maps to pnpm's **catalog**
protocol — versions declared once in `pnpm-workspace.yaml`, packages reference `catalog:`. Same
rule, same enforcement (`syncpack` in CI). Turbo's `--filter=...[origin/develop]` gives
affected-only builds.

**D.** Layout, scoped:

```
apps/
  platform       # Fastify — control plane: tenants, licences, telemetry ingest
  store          # Fastify — the data plane API, one image, two modes
  admin          # TanStack Start — platform console
  dashboard      # TanStack Start — merchant dashboard
  storefront     # Next.js
  fake-bank      # Fastify, run-mode only
packages/
  core           # errors, PhoneNumber, pagination, telemetry, tenant context
  contracts      # Zod schemas
  db-platform    # Drizzle schema + migrations
  db-store       #   "
  clients        # generated from OpenAPI: typed client + TanStack Query hooks
```

> Revised per the status note. There is **no `apps/identity`** — identity is a Logto container
> with its own database, so `packages/db-identity` is gone too. The split that remains is
> **control plane vs data plane**, which is a deployment boundary, not a service decomposition.

---

## The two API services

**E.** **Fastify**, not Nest. Nest is the closer emotional port (DI container, guards ≈
`[RequiresClaim]`, interceptors ≈ MediatR pipelines, filters ≈ the `ApiException` middleware) and
it's a defensible choice if the team wants minimal retraining. But it costs decorator metadata (no
native TS stripping, SWC forever) and inference at the route boundary. You already hand-built your
framework once as `MercuryWebApp`; on Fastify that's ~400 lines and full inference.

**F.** **Zod for validation, OpenAPI as the contract.** Not ts-rest/tRPC — OpenAPI, because the
contract has consumers you don't control the language of (and, per **Q5**, possibly surviving .NET
services):

```
Zod schema → fastify-type-provider-zod → @fastify/swagger → OpenAPI
                                                              ├→ @scalar/fastify-api-reference   (Scalar, ported 1:1)
                                                              ├→ Orval/Kubb → typed client + TanStack Query hooks
                                                              └→ any non-TS consumer
```

The panel's hand-written `Requests/Apis/**` folder becomes generated output. That deletion is most
of the case for doing this at all.

**G.** Build-enforced conventions survive, moved: `BannedSymbols.txt` + RS0030-as-error becomes an
**ESLint** rule (`no-restricted-syntax` banning `reply.send()` in handlers and bare
`throw new Error`) with `--max-warnings 0`. The Roslyn architecture test that enforces
subscribe-before-first-await (#894) becomes **ts-morph** — same technique, same idea.

**H.** Drop MediatR. Its jobs here are pipeline behaviours (→ Fastify hooks) and the Hangfire
bridge (→ gone with Hangfire, see **AI**). `MediatrPipelines/CampaignPipeline.cs` becomes an
ordinary function.

---

## Data

**I.** Nothing in TS is EF Core. **Drizzle** is where I'd land — SQL-first, best-in-ecosystem
types, `customType` covers your value converters, `drizzle-kit` for migrations, and it forces you
to delete the generic `Repository<T>` rather than port it. **MikroORM** is the least-retraining
alternative (identity map, unit of work, entity classes — it is the EF Core of TS). Prisma isn't
suited to two databases plus heavy raw SQL.

**J.** The one place the rewrite is strictly ahead. Your `CLAUDE.md` carries two hard-won
migration rules: never hand-write a migration file (a missing `[Migration]` attribute compiles,
deploys and is *silently ignored*), and never let a migration's `defaultValue` contradict the
entity initializer (one mismatch silently deactivated 50 of 61 production users for two months).
**Neither failure mode exists in Drizzle** — the default lives in the schema, the SQL is generated
from it, there is one source.

| Mercury today | TypeScript |
|---|---|
| `Sieve` dynamic filtering/sorting | ~150-line query-param → `where`/`orderBy` builder over a per-entity allowlist |
| `PagedResult<T>` (unified in #820) | a generic in `@mercury/core` |
| `EntityTypeConfiguration` | Drizzle schema files, colocated per table |
| `PhoneNumber` value converter + JSON converter | `customType` + a Zod branded type; the Turkish numbering plan is plain code |
| Migrate-on-boot | `drizzle-kit migrate` as an init step — **better**, no race when replicas scale |
| `db-identity`, `db-store` containers | unchanged, still Aspire-managed |

---

## Scheduled work — the Hangfire question

**AM.** Dropping Hangfire is right, and the replacement is **not another queue**. Store's only
Hangfire usage is campaign scheduling: `CampaignEntity.HangfireStartJobId` /
`HangfireEndJobId`, two jobs per campaign that flip it on at its start time and off at its end,
with `HangfireUtils.SafeDelete` on the ids when the campaign changes.

That's a **state transition, not a side effect** — and a state transition derived from two columns
doesn't need a scheduler at all:

```ts
// campaign is active when the clock says so; no job, no job id, no drift
const active = and(lte(campaigns.startsAt, sql`now()`), gt(campaigns.endsAt, sql`now()`));
```

**AN.** So the design carries **no job queue** — no Hangfire, no pg-boss, no BullMQ, no Redis. What
that buys beyond a dependency: two columns disappear, `CampaignPipeline` disappears, and so does
the entire class of bug where the persisted job id drifts from the row it points at (a rescheduled
campaign whose old job still fires, a `SafeDelete` that silently didn't).

The rule for later: add **pg-boss** (Postgres-backed, no Redis) the first time a job produces a
*side effect* that can't be derived from a timestamp — an email at T+24h, a bulk export, a
retryable webhook. Not before.

---

## Realtime

**AS.** `RelayHub` and `BridgeHub` leave with the devices. The only survivor is **`StoreHub`** —
`Hub<IPortalClientContract>`, pushing support-task (`Td`) updates to the panel. That is one
feature, one direction, server → client.

So: **not Socket.IO. Server-Sent Events.** Native in the browser, native in Fastify
(`reply.sse` or a plain stream), passes through Traefik, reconnects on its own, and needs no
client library and no adapter. Socket.IO earns its weight when you need bidirectional messaging,
rooms, acks and a Postgres/Redis adapter — with one notification stream you'd be paying for all of
it and using none of it.

Store → Identity is currently a SignalR *hub call* (Store connects to Identity's hub as a client
for customer creation, via `MercurySettings__Signalr__Identity`). In the rewrite that becomes a
plain typed HTTP call through the generated client. SignalR-as-RPC was always the odd one out.

---

## Edge and orchestration — Aspire stays

**P.** Aspire is not a .NET orchestrator — it's a process/container graph with a dashboard, and a
Node service is a first-class resource in it. Add `Aspire.Hosting.NodeJs` to
`Directory.Packages.props` and `AspireProgram.cs` barely moves:

```csharp
// today
var store = builder.AddProject<Mercury_Store_Api>("api-store")
                   .WithHttpEndpoint()
                   .WithReference(storeDb)
                   .WaitFor(storeDb)
                   .WithEnvironment("InternalApi__Key", internalApiKey)
                   .WithPostHog(postHogApiKey, postHogHost, postHogPersonalApiKey);

// after
var store = builder.AddPnpmApp("api-store", "../../../apps/store", "dev")
                   .WithHttpEndpoint(env: "PORT")   // Aspire assigns the port, Node reads it
                   .WithReference(storeDb)          // → ConnectionStrings__cs-store
                   .WaitFor(storeDb)
                   .WithEnvironment("InternalApi__Key", internalApiKey)
                   .WithPostHog(postHogApiKey, postHogHost, postHogPersonalApiKey)
                   .PublishAsDockerFile();
```

Configurable exactly as it is today: `AddPnpmApp` runs `pnpm dev` **on the host** against a
containerized Postgres (fastest inner loop, the current arrangement), or `AddDockerfile` /
`AddContainer` runs the service **in a container** too. Same graph, same dashboard, and
per-resource `rebuild` works on a Node resource as it does on a .NET one.

Untouched: the `AddPostgres(…).PublishAsContainer().AddDatabase(…)` blocks (now two), the
`WaitFor` graph, and the `#818` non-persistent-lifetime decision and its reasoning.

| Aspire injects | TypeScript side |
|---|---|
| `ConnectionStrings__cs-store` | `process.env["ConnectionStrings__cs-store"]` → Drizzle (bracket access — the dash isn't a valid identifier) |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` | `@opentelemetry/sdk-node` reads all three from env with **zero config** — traces land in the Aspire dashboard on first run |
| endpoint port via `WithHttpEndpoint(env: "PORT")` | `fastify.listen({ port: Number(process.env.PORT) })` |
| `services__api-identity__http__0` | nothing reads it for you — see **AD** |

**AD.** The one real gap is **`Microsoft.Extensions.ServiceDiscovery`**, a .NET *client library*,
not an Aspire feature. ~20 lines in `@mercury/core`:

```ts
export const discover = (name: string, scheme = "http") =>
  process.env[`services__${name}__${scheme}__0`] ??
  (() => { throw new Error(`no endpoint published for ${name}`) })();
```

With Store and Identity as the only two services, this gets called in exactly one direction.

**AE.** `AddServiceDefaults()` is the other .NET convenience, and you already replaced it —
`MercuryWebApp` *is* your service defaults. It gets a TypeScript twin in `@mercury/core`.

**AF.** `DistributedApplicationTestingBuilder` is genuinely C#-only from a TS test runner, but the
loss is narrow: what `Mercury.Store.Tests.Integration` needs is a real Postgres, and Testcontainers
hands Vitest that directly. Whole-stack assertions go to Playwright against `aspire run --detach`.
You lose the typed application model in tests, not the ability to test against the real stack.

**AG.** So the rewrite is **not all-TypeScript**: `AspireProgram.cs` stays C#. That's 285 lines
nobody edits daily, carrying more institutional rationale per line than any other file in the repo.
It is the most valuable file to *not* rewrite. And because it survives, **`aspire publish`** stays
available as the fix for the hand-maintained compose variants — independent of any rewrite.

**AH.** Worth verifying on your 13.5.3, which I won't assert: how far non-C# AppHost authoring has
landed. If it's usable, **AG**'s first sentence goes away.

**O.** **The gateway.** With two APIs behind it, `Mercury.Gateway` is 212 lines of YARP doing very
little. Options, in order of how much I'd like them: fold routing into **Traefik** (already in the
Coolify deploy) and keep a thin Fastify edge only for what must be code — the `ResolveClientIp`
fix (the caller-chosen rate-limit partition key), rate limiting via `rate-limiter-flexible`,
internal-key injection; or keep YARP as-is, since nothing forces it to be TypeScript; or drop the
gateway entirely and let the two front ends call the two APIs directly through Traefik. A Node
reverse proxy in the hot path buys nothing either way.

---

## Observability and auth

| Mercury today | TypeScript |
|---|---|
| OpenTelemetry .NET (pinned `$(OTelVersion)` family) | `@opentelemetry/sdk-node` + `auto-instrumentations-node` |
| Serilog → console + OTLP | **pino** + `pino-opentelemetry-transport` |
| GlitchTip via Sentry SDK | `@sentry/node` — GlitchTip is Sentry-compatible |
| PostHog server-side analytics + flags | `posthog-node` — same product, same EU-host caveat, and per #713 still **off** for the panel |
| prometheus-net + Grafana | `prom-client`, Grafana unchanged |
| Hand-rolled JWT (`JwtAuthenticationManager`) | **jose** — JWK, rotation, audited |
| Password hashing | **@node-rs/argon2** |
| OTP rate limiting (`OtpRateLimitTests`) | **rate-limiter-flexible** (Postgres store) |
| BouncyCastle hybrid RSA+AES (mobile client) | `node:crypto` RSA-OAEP + AES-GCM — simpler than what you have ❓ *(mobile may be out of scope — **Q6**)* |
| `[RequiresInternalKey]` shared secret | a Fastify plugin, identical shape |

**S.** Keep the hand-rolled identity. Turkish phone numbers as primary identity, OTP-first login,
and `jti` deliberately pinned as the stable user id (Store persists it as
`CustomerEntity.IdentityId`, PostHog uses it as distinct id) are *data* constraints, not framework
ones — and per **Q5** they may be pinned by surviving .NET services too, which makes them
non-negotiable rather than merely expensive. They port unchanged. Don't fold "adopt Keycloak /
better-auth" into this.

The generic-error-code-but-log-the-real-check rule (so an auth endpoint can't enumerate accounts)
ports as a helper plus a lint rule.

---

## The admin panel

**U.** ~93 pages across 13 areas is still the second-biggest item and most of the risk. **TanStack
Start / Router**, not Next.js, for this one: the panel is app-shaped — auth-gated, filter-heavy,
deep-linked table state — and type-safe search params matter more here than RSC does. The
storefront stays on Next (see below); two frameworks in one monorepo is fine when they're solving
different problems.

**@fluentui/react-components (Fluent UI v9)** keeps the design language identical — same team, same
tokens as the FluentUI Blazor v5 RC you're on — so 93 screens are a translation, not a redesign.

**V.** Most of the panel's heavy lifting is already JS libraries wearing .NET wrappers:

| Panel today | TypeScript |
|---|---|
| `Requests/Apis/**` hand-written gateway layer | **deleted** — generated clients + TanStack Query hooks |
| FluentUI Blazor v5 RC | `@fluentui/react-components` v9 |
| `DataTables.Blazor` / `FluTable` | **TanStack Table** (headless), AG Grid only if a grid really needs it |
| `PSC.Blazor.Components.Chartjs` | **Chart.js** directly — the wrapper and its NuGet-name confusion go away |
| `Markdig`, raw HTML disabled | `react-markdown` *without* `rehype-raw` — same rule, same place |
| `ClosedXML` (xlsx export) | **exceljs** |
| `QRCoder` (e-Fatura QR) | **qrcode** |
| `Blazored.TextEditor` (Quill) | **TipTap** |
| `Blazored.SessionStorage` | `sessionStorage` + a typed wrapper |
| NavCatalog + command palette | **cmdk** |
| Invoice render → browser print engine | unchanged — it was always the browser |
| `TypedSignalR.Client` → `StoreHub` | **SSE** (see **AS**) |
| `Z.Blazor.Diagrams` | **gone** — it drew device topology (Relay) |

**W.** The cost nobody mentions: **Blazor Server needs no API layer for internal tools.** Panel
code calls a service and renders. A React panel needs every one of those ~93 pages' data to become
an HTTP endpoint with a schema and an auth check. Generated clients make it cheap per endpoint, but
it is not free, and it is new surface area on a tool that currently has none. With Invoice and
Admin carrying two thirds of the pages, most of that new surface is invoicing endpoints.

---

## The storefront

**AO.** It's already Next.js and already TypeScript, so "adding it" is mostly *integration*, not
rewriting:

1. **Move it into the monorepo** as `apps/storefront` — it's tracked source in the Mercury repo
   today, not a submodule, so this is a file move plus a `package.json`.
2. **Delete its hand-written API layer** and consume `packages/clients`. This is where it stops
   being a second-class citizen: today it calls a gateway it has no contract with; after, its calls
   fail `tsc` when Store's schema changes.
3. **Share `packages/contracts`** so a product, price or campaign shape is one Zod schema across
   storefront, panel and API.
4. **Auth against Identity** the same way the panel does — OTP-first login, JWT in an httpOnly
   cookie set by a route handler (never `localStorage`), refresh keyed on the `sid` session claim.
5. **Keep it on Next.js App Router.** A storefront is content-shaped: ISR for catalog pages,
   `revalidateTag` fired when the panel publishes a change, `next/image`, `next-sitemap` and
   structured data for SEO, `next-intl` for the Turkish UI convention.

**AP.** One genuine design decision here: the campaign-active predicate from **AM** must be
evaluated in *one* place. If the storefront caches a page with a campaign that expires at 18:00,
ISR has to be tag-invalidated at 18:00 — which is the one thing in this design that looks like it
wants a scheduler. It doesn't: render the price with its validity window and let the client clamp,
or set `revalidate` to the next boundary. Worth deciding deliberately rather than reaching for
pg-boss on reflex.

---

## Testing and CI

**X.** **Vitest** + **Testcontainers** (`@testcontainers/postgresql`, the approach you already use)
+ `@faker-js/faker` (Bogus) + `vi.useFakeTimers` (`TimeProvider.Testing`) + **msw** at HTTP
boundaries.

| Mercury test tooling | TypeScript |
|---|---|
| xunit `[Fact]` / `[Theory]` | Vitest `test` / `test.each` |
| NSubstitute | `vi.fn()` / `vi.mock` |
| Bogus | `@faker-js/faker` |
| Testcontainers.PostgreSql | `@testcontainers/postgresql` |
| `DistributedApplicationTestingBuilder` | Playwright against `aspire run --detach` (see **AF**) |
| `TimeProvider.Testing` | `vi.useFakeTimers()` |
| Roslyn architecture test (#894) | **ts-morph** |
| — | **Playwright** (you have no e2e today) |

In-scope test projects to port: `Mercury.Store.Tests.Integration` (14 files), `Mercury.Identity.Tests`
(13), `Mercury.Core.Tests` (8), `Mercury.Portal.Web.V5.Tests` (18). The VPN and Payment suites —
the two largest, 27 and 12 files — leave with their services.

**Y.** And the rewrite is the moment to fix the top finding from the eShop comparison: **GitHub
Actions running `turbo run typecheck lint test --filter=...[origin/develop]` on every PR, plus
Playwright.** 840 tests that nothing runs on push is the clearest gap in the current repo. If
nothing else here happens, this should.

---

## Full stack table

| Layer | Mercury (.NET 10) | Pick | Runner-up |
|---|---|---|---|
| Runtime | .NET 10 | Node LTS 24/26 | Bun (tooling only) |
| Build | MSBuild + `global.json` | tsdown + Turborepo | Nx |
| Monorepo | `Mercury.sln` | pnpm workspaces | — |
| Central versions | `Directory.Packages.props` | pnpm **catalog:** + syncpack | — |
| Orchestration | **Aspire AppHost** | **unchanged** (`AddPnpmApp` / `AddDockerfile`) | — |
| Dashboard / OTLP | Aspire dashboard | **unchanged**, zero-config from `sdk-node` | — |
| HTTP | ASP.NET Core MVC controllers | **Fastify** + `@mercury/core` | NestJS (Fastify adapter) |
| Validation | model binding + `ApiException` | **Zod** | TypeBox, Valibot |
| Contract | none | **OpenAPI** via `fastify-type-provider-zod` | ts-rest / oRPC |
| API docs | Scalar | **@scalar/fastify-api-reference** | — |
| Clients | hand-written `Requests/Apis/**` | **Orval** / Kubb → TanStack Query hooks | openapi-fetch |
| Errors | `ApiException` + middleware | typed error classes + `setErrorHandler` → RFC 9457 | — |
| Convention enforcement | `BannedSymbols.txt`, RS0030=error | **ESLint** `no-restricted-syntax`, `--max-warnings 0` | — |
| Architecture tests | Roslyn | **ts-morph** | — |
| In-process dispatch | MediatR | plain handlers | — |
| ORM | EF Core 10 | **Drizzle** | **MikroORM** (least retraining) |
| Migrations | EF migrations at startup | `drizzle-kit` as an init step | — |
| Filtering | Sieve | allowlist query builder (~150 lines) | — |
| Scheduled work | Hangfire (Postgres) | **none** — derive from timestamps (**AM**) | pg-boss, when a real side effect appears |
| Realtime | SignalR (`StoreHub`) | **SSE** | Socket.IO |
| Service-to-service | SignalR hub call | typed HTTP via generated client | — |
| Gateway | YARP (212 lines) | **Traefik** + thin Fastify edge, or keep YARP | drop it (2 services) |
| Rate limiting | custom + `ResolveClientIp` | **rate-limiter-flexible** | `@fastify/rate-limit` |
| Resilience | Polly / `Http.Resilience` | `cockatiel`, or `undici` retry | — |
| Tracing/metrics | OpenTelemetry .NET | `@opentelemetry/sdk-node` | — |
| Logging | Serilog → OTLP | **pino** + otel transport | winston |
| Errors (prod) | GlitchTip | `@sentry/node` | — |
| Analytics/flags | PostHog | `posthog-node` | — |
| JWT | hand-rolled | **jose** | `@fastify/jwt` |
| Hashing | ASP.NET Identity | **@node-rs/argon2** | bcrypt |
| Admin UI | Blazor Server + FluentUI Blazor v5 | **TanStack Start** + `@fluentui/react-components` v9 | Next.js + Mantine / shadcn |
| Tables | DataTables.Blazor / FluTable | **TanStack Table** | AG Grid |
| Charts | PSC.Blazor.Components.Chartjs | **Chart.js** | ECharts, Recharts |
| Markdown | Markdig (raw HTML off) | `react-markdown` (no `rehype-raw`) | markdown-it + DOMPurify |
| Spreadsheets | ClosedXML | **exceljs** | SheetJS |
| QR | QRCoder | **qrcode** | — |
| Rich text | Blazored.TextEditor | **TipTap** | — |
| Storefront | Next.js | **Next.js**, moved into the monorepo | — |
| Unit tests | xunit + NSubstitute + Bogus | **Vitest** + `vi.fn()` + faker | — |
| Integration tests | Testcontainers + Aspire.Hosting.Testing | `@testcontainers/postgresql` | — |
| E2E | — | **Playwright** | — |
| CI | none | **GitHub Actions** + Turbo affected | — |
| Deploy | Coolify + Traefik, hand-written Dockerfiles | unchanged; multi-stage `pnpm deploy --filter` images | `aspire publish` |

No ⚠️ rows left. The scope cut took every library that was worse in TypeScript than in .NET.

---

## How I'd sequence it

**AQ.** Strangler behind Traefik, smallest coherent slice first. The old ladder (DownloadHelper →
Vpn → Medicine → …) is gone with those services, so the order is driven by dependency instead:

1. **`packages/core` + `packages/contracts` + Identity.** 12.7k lines, the best-tested thing you
   own, and nothing else can move until sessions and `jti` work. Ends with the panel and storefront
   both authenticating against TS Identity while every other service still runs .NET.
2. **Store read paths** — catalog, product, campaign queries. Safe to run side-by-side against the
   same database as the .NET Store, which is the cheapest possible correctness check: same request,
   two implementations, diff the responses.
3. **Storefront onto generated clients.** It's already TS, so this is where the single-language
   payoff first shows up — and it's the lowest-risk front end because it's mostly reads.
4. **Store write paths** — orders, invoicing. The real work, and where **Q4** has to be answered.
5. **Panel, area by area.** `Customer` and `Td` first (small, and `Td` exercises SSE). `Invoice`
   (35 pages) and `Admin` (31) last, together — they're two thirds of the panel and should be
   scheduled as their own project.

**AR.** Revised verdict. My original **AC** said don't do this — but that was priced against SOAP,
XML-DSig, PCI-adjacent payment code and 175k lines. Scoped to Identity + Store + panel + storefront,
with Aspire kept and Hangfire dropped, it's a different proposition: the remaining system is a
commerce API, an auth service and two front ends, one of which is already TypeScript. That is the
subset TS is genuinely good at, and there is no library on the list you'd be downgrading.

It is still 186k lines and still 12+ months, and the honest cheap alternative hasn't changed:
generate OpenAPI from the *existing* .NET Store and Identity, generate TS clients, and move the
storefront and two or three panel areas onto them. You get the single-language payoff at the
storefront/panel seam — which is where **A** says the whole prize is — while keeping EF Core,
Aspire, and the tests that already pass. If that lands well, steps 1–5 above are the same plan with
one fewer leap of faith.

---

## Open questions

**Q4.** Does Store still take card payments? `Store.Api/Payment/PaymentApiClient.cs` is a thin HTTP
client to `api-payment`, and dropping the Payment *service* doesn't drop *checkout*. Three readings:
TS Store keeps calling the surviving .NET payment service (fine — it's one HTTP client, and the
`#836` PAN-bypass reasoning carries over unchanged); or checkout is out of scope for now; or
payments move to a provider SDK. This decides whether step 4 above is two weeks or two months.

**Q5.** ✅ **Answered — standalone. The dropped services go away entirely.** No surviving .NET
consumers, so nothing downstream pins `jti`, the internal-key scheme or the claim shapes. They stop
being contracts and become choices, which is what makes **CZ** possible: adopt an IdP rather than
port one. This is also what turns the whole exercise from a port into a greenfield POC.

**Q6.** Is the mobile API surface in scope? `Medicine/Features/Mobile` leaves with Medicine, but
the BouncyCastle hybrid RSA+AES path is in `Mercury.Core` and Identity-adjacent. If mobile is out,
that row leaves the table too.

**Q7.** Does the panel's `Import` area (4 pages) belong to Medicine's drug import, or to Store? It's
the one area I couldn't classify from the folder name.

**Q8.** ✅ **Resolved by Q5.** With no .NET consumers and identity bought rather than built, there
is no "Store vs Identity" split left to argue about — the identity service isn't ours to split.
What remains is **`platform` (control plane) and `store` (data plane)**, and that boundary is not a
service decomposition you could collapse into a monolith: the data plane has to be separately
deployable because it ships to a customer's VPS. The gateway question from **O** survives in a
smaller form — with one public API per plane, Traefik routing plus a thin edge is enough, and the
service-discovery shim in **AD** is needed in exactly one direction.

**Q3.** *(still open)* Nest or bare Fastify? I argued Fastify in **E**; if the team's instinct is
"where's my DI container", Nest is the lower-drama choice and I wouldn't fight it.

**Q2.** *(still open)* Is the driver hiring/team composition, or the storefront/panel type gap? It
decides between **AQ** and the cheaper alternative in **AR**.

**Q1.** *Withdrawn — the relay device agent left with DownloadHelper and the Bridge/Relay hubs.*

---

*Written 2026-09-21, revised 2026-09-22 against `mercury@c7f4e009` (`develop`). Companion to
`~/Desktop/projects/alternet/mercury-vs-eshop.md`, which supplies most of the architectural facts cited here.*
