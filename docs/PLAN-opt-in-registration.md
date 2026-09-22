# Plan — opt-in registration for dedicated tenants

Target: **v2.0.0**. Baseline: **v1.0.0** (`a1626d0`), which runs end to end. If a phase cannot be
made to work, stop and report — do not leave the repo worse than the tag.

This document is the whole brief. It assumes no conversation history.

---

## The problem

Adding a second dedicated (tier 3) tenant today costs **~14 edits across 4 files plus a copied
AppHost**. Almost all of that is incidental, but one thing is forced and drags the rest along:

> **AppHost A must know the dedicated store's address before that store exists**, because it
> registers `${STORE_DEDICATED_URL}/auth/callback` as a Logto redirect URI at bootstrap time. A
> redirect URI Logto has not been told about is rejected at the end of the login round-trip.

That is the *only* reason `MERCATUS_STORE_DEDICATED_PORT` (28403) is a fixed port rather than
Aspire-assigned. Everything else — the copied AppHost, the per-instance paths, the manifest
filename — follows from treating a dedicated instance as something A configures in advance.

## The target

Flip it. **A mints a token; the instance opts in and tells A where it lives.**

```
operator  ──►  POST /installations          { tenantSlug, expectedHost }
              ◄── { installationId, bootstrapToken }          one-time, host-pinned

instance  ──►  POST /installations/register { bootstrapToken, version,
                                              baseUrl, dashboardUrl }
              platform validates baseUrl host === expectedHost
              platform calls Logto Management API, adds the redirect URIs
              ◄── { instanceToken, oidc: { issuer, clientId, clientSecret }, licence }

instance       caches it, fetches JWKS, serves
```

After this, a new dedicated tenant needs **zero edits to AppHost A**.

---

## What already exists — do not rebuild it

| | Where |
|---|---|
| `POST /installations` mints a one-time bootstrap token | `apps/platform/src/routes/installations.ts` |
| `POST /installations/register` burns it, returns an instance token | same file |
| One-time semantics, race handling, one generic failure (`S1`) | same file |
| The instance registers at boot and caches its credential | `apps/store/src/provision.ts`, `apps/store/src/instance.ts` |
| Heartbeat with version / tenant / licence id | platform + store |
| Logto Management API client | `packages/identity/src/bootstrap.ts` |

The handshake is already there. It just never says **where the instance lives**.

---

## Phases

Each phase ends with a gate that **executes**. Commit per phase. Never push — the human pushes.

### Phase 0 — put the dedicated instance on real OIDC *first*

> **Status — ✅ done, `1c6f609`.** Gate executed: a real browser login round-trip completed
> against the dedicated store, and a shopper signed in at a pooled store was recognised at the
> dedicated one (same subject). Two things were broken, both small:
> `IDENTITY_CACHE_PATH_DEDICATED` was never set by AppHost A, and A registered `127.0.0.1` while
> B asked for `localhost`, which Logto compares as strings. `diary/14`, `lessons/14`.

Today `AUTH_ADAPTER` defaults to `stub` in both AppHosts; `MORNING.md` confirms the browser suite
drives the stub, and AppHost B's own comment says its `ext-identity` reference is "unused while
this instance runs on the stub adapter".

**Do this before touching registration**, while the dedicated store's address is still a constant.
If the OIDC handshake is broken, you want to find out now and not while also changing how the
redirect URI gets registered.

- Run AppHost A and AppHost B with `AUTH_ADAPTER=oidc`.
- Fix whatever breaks.
- **Gate:** a real browser login round-trip completes against the **dedicated** store, and a
  shopper signed in at a pooled store is recognised at the dedicated one. Paste the observed
  sequence. `packages/identity/scripts/login-round-trip.sh` exists and may help.

### Phase 1 — opt-in registration

> **Status — ✅ done, `93fd588`.** All nine items landed, including the deletion in item 8:
> `STORE_DEDICATED_URL`, `MERCATUS_STORE_DEDICATED_PORT` and `storeDedicatedBase` are gone and
> four fixed ports became three. Gate executed: B started on an Aspire-assigned port, registered,
> the redirect URI was confirmed through the Management API, a real browser login completed, and
> a mismatched host was refused with the generic 401. Item 4 turned out to be the easy part
> (`packages/identity/src/logto.ts` already had the client); the awkward part was getting the M2M
> secret to the platform without letting it read Logto's Postgres — a 0600 handoff file, opened
> lazily. One deviation worth knowing: a failed host check does **not** burn the bootstrap token
> (`FR` in `docs/V2.md`). `diary/15`, `lessons/15`.

1. Add `baseUrl` and `dashboardUrl` to the register request. Contracts first
   (`packages/contracts`), then `apps/store/src/provision.ts` — the instance knows its own
   address from `PORT`/endpoint env by then.
2. Add `expectedHost` to `POST /installations`, and persist it plus the registered URLs on the
   installation row (`packages/db-platform` schema + migration).
3. **Security, not optional (`GK`).** Register must reject a `baseUrl` whose host does not match
   the installation's `expectedHost`. Without it a stolen bootstrap token becomes a
   token-exfiltration vector: an attacker registers `evil.com/auth/callback` and harvests auth
   codes for that tenant. One generic failure to the caller, the real reason in the log (`S1`).
4. Extract the Logto Management API client from `packages/identity/src/bootstrap.ts` so
   `apps/platform` can call it at **runtime**, not only from the bootstrap task. The platform then
   needs the M2M credential — wire it through AppHost A. **This is the awkward part of the job.**
5. On register: read-modify-write the relevant Logto application's `redirectUris`, adding
   `${baseUrl}/auth/callback` and `${dashboardUrl}/callback`. Idempotent — re-registering the same
   URL must not duplicate it.
6. Return `{ issuer, clientId, clientSecret }` in the register response so the instance is
   configured **by the answer**, not by env.
7. On deregister/uninstall, remove those URIs again, or the list grows forever (`CK1` — build
   deprovisioning at the same time as provisioning).
8. **Delete** `STORE_DEDICATED_URL` and `MERCATUS_STORE_DEDICATED_PORT`, and the dedicated entries
   in `packages/identity/src/bootstrap.ts`. The dedicated store's port goes back to being
   Aspire-assigned. This deletion is how you know the phase worked.
9. AppHost B should now need only `PLATFORM_URL` and `INSTANCE_BOOTSTRAP_TOKEN`.

**Gate:** with A running, start B on an Aspire-assigned port, watch it register, confirm the
redirect URI appears in Logto via the Management API, and complete a **real browser login** on the
dedicated store. Then confirm a mismatched host is rejected.

### Phase 2 — parameterise AppHost B

> **Status — ✅ done, `106a39b`.** Gate executed: `MERCATUS_TENANT_SLUG=zenith` reproduced v1.0.0
> behaviour with the suite green. Every resource name, container, database, path and manifest
> file derives from the slug, and the e2e helpers glob `.stack/apphost-*.json` and key per
> instance. `diary/16`, `lessons/16`.

One AppHost, any tenant, by environment:

```bash
MERCATUS_TENANT_SLUG=orion aspire run --detach
```

Everything derives from the slug: resource names (`api-store-tenant-{slug}`,
`web-storefront-tenant-{slug}`, `pg-tenant-{slug}`, `db-tenant-{slug}`, `task-*-tenant-{slug}`),
`.instance/{slug}.json`, `.identity/store-{slug}.json`, `.next-{slug}`,
`.stack/apphost-{slug}.json`, and the dashboard port in `apphost.run.json`.

Note `.stack/apphost-b.json` becomes `.stack/apphost-{slug}.json`, so the e2e helpers
(`packages/e2e/tests/helpers/stack.ts`, `global-setup.ts`) must merge by glob and key per
instance rather than on the fixed names `store_dedicated` / `storefront_dedicated` /
`dashboard_dedicated`.

**Gate:** `MERCATUS_TENANT_SLUG=zenith` reproduces exactly today's behaviour, with the whole e2e
suite green.

### Phase 3 — prove it with a second dedicated tenant

> **Status — ✅ done, `f7f3d0f`.** Gate executed: two pooled and two dedicated tenants serving at
> once, one shopper account buying from all four, each merchant's dashboard showing only its own
> orders, and both dedicated stores still completing checkout with the control plane stopped.
> Two blockers were real and neither was in the plan: a tenant bought after A started had no
> Logto organization (fixed by `ensureOrganizationBySlug` **at the control plane**, not by
> teaching A a slug list), and the Aspire CLI treats a running AppHost as a singleton keyed on
> its file path, so two Bs need two directories — hence `aspire/scripts/run-dedicated.sh`.
> `diary/17`, `lessons/17`.

Add **orion** with zero edits to AppHost A: create the installation in the platform console (or
via the API), take the token, run AppHost B a second time with a different slug.

**Gate:** two pooled tenants and **two** dedicated tenants all serving at once; one shopper
account buys from all four; each merchant's dashboard shows only its own orders. Then stop the
control plane and show both dedicated stores still completing checkout.

---

## Rules

- Read `docs/dos-and-donts.md` and follow the rules by id. The ones that bite here: `CE1`
  (per-instance credentials), `CE4` (outbound only — the instance pulls, A never pushes), `CD4`
  (one issuer), `CK1` (deprovisioning built with provisioning), `S1` (one generic failure, log the
  real reason), `BL1` (the leak suite must be able to fail).
- Read every file in `lessons/` before starting. Write `diary/<NN>-<slug>.md` and
  `lessons/<NN>-<slug>.md` after, even on failure. Append undocumented decisions to
  `docs/decisions-made-overnight.md`.
- Gates execute. "It compiles" is not a gate.
- `aspire run` must be `--detach`, and killed when done. Clean up containers.
- Ports: never 3000. The edge is `28080`; Logto `28311`/`28312`. After phase 1 there should be
  **three** fixed ports, not four.
- Commit per phase, conventional messages. **Never push.**
- If something fights for more than ~20 minutes, take the simplest path that keeps the build
  moving, write it in `lessons/`, and continue.

## Definition of done

Two pooled tenants, two dedicated tenants, real OIDC on both planes, one shopper account across
all of them, `MERCATUS_STORE_DEDICATED_PORT` gone, a host-pinned bootstrap token, and a new
dedicated tenant costing one command and zero edits to AppHost A.

> **Status — met as a running system, not as a self-proving one.** Five of the seven items are met
> outright. "Real OIDC on both planes" is true of the system and **not** of the evidence: specs
> `01`–`04` skip under `AUTH_ADAPTER=oidc` and spec `05` skips under the stub, so no single run
> demonstrates the whole list (22 passed / 6 skipped on stub; 6 passed / 22 skipped on oidc). The
> host pin is met with an exception the docs did not state. Item by item, with the nine open
> findings from the acceptance run, is [`docs/V2.md`](./V2.md) §6 and §4.
>
> **An unplanned round happened after the first acceptance run failed the release** — `e06df86`,
> `bebcf46`, `8350fdb`, `3661b61`. `MERCATUS_AUTH_ADAPTER=oidc` put the store API on a real issuer
> and left both browser front ends unable to sign anybody in, on both planes, because they called
> `/dev/login/*` directly and those routes exist only under the stub. "Real OIDC on both planes"
> and "one shopper account buying from four shops in a browser" were mutually exclusive until it.
> `diary/18`, `lessons/18`.
>
> **The worst thing left open is `FJ`**: a control-plane rebuild silently kills sign-in at every
> already-running dedicated box, and the documented recovery — restarting the box — recreates its
> Postgres and destroys that merchant's orders. It is `EV` in `docs/OPEN-DEFECTS.md`, understated
> there.
