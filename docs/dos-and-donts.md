# Do's and Don'ts

Rules with reasons, for a multi-tenant platform with a **pooled** data plane (ours) and a
**dedicated** data plane (the customer's VPS, our code), sharing one control plane for identity,
licensing and telemetry.

Each rule carries the label of the discussion it came from, so it can be pointed at (`CE3`,
`BV1`, …). Roughly ordered by how expensive the mistake is to undo: the first two sections are
things you cannot fix later without a migration or an incident.

> A rule here earns its place by having a failure behind it — either one Mercury already had, or
> one visible in prior art we read. Where the failure is known, it's named.

---

## 1. Trust — the customer has root · `CE`

The dedicated data plane runs on infrastructure you do not control and they do. Every rule in this
section follows from that one sentence.

| # | Don't | Do | Why |
|---|---|---|---|
| **CE1** | Put a shared or global secret on a data plane you don't operate | Issue **per-instance credentials**, individually revocable | One leaked key on one merchant's VPS is otherwise a platform-wide incident, and you will not know which box leaked it |
| **CE2** | Call *your* third-party accounts (SMS gateway, payment merchant, mail) from their box | Proxy those calls through the control plane, **or** have each tenant bring their own provider account | Their server holding credentials that bill you is a standing invitation, and revoking them breaks every other tenant |
| **CE3** | Bill from usage numbers a data plane reports | Sign the reports, treat them as **telemetry**, and enforce limits through the signed licence | They can edit the numbers. Metering you can't verify isn't metering |
| **CE4** | Open inbound connections into their network — SSH, VPN, a callback port | Data plane **pulls** config and updates; **pushes** telemetry. Outbound only · `CF` | The day support needs to SSH into a customer VPS, you have bought an on-prem support business instead of a SaaS |
| **CE5** | Assume their database is private from them | Treat the data plane's DB as readable by the customer | It is their machine. Design so that this is fine, because it's true whether you design for it or not |
| **CE7** | Let "we can SSH in" become the update mechanism, even while we operate the box ourselves | Instances **register, pull config, pull updates, push telemetry** — from day one | Reachability during a POC is an accident of hosting, not a design. Push-based updates are the most expensive thing to undo when the customer starts owning the server |
| **CE6** | Ship a build that can't tell you what it is | Every data plane reports its **version, tenant and licence id** on every telemetry batch | Version skew is invisible until you can query it · `CH` |

---

## 2. Identifiers — the mistake that propagates

| # | Don't | Do | Why |
|---|---|---|---|
| **BV1** | Use an external system's primary key as your tenant id | Mint your own `tenant_id`; store `stripe_subscription_id` as an *attribute* | Mercury did this with `jti`-as-user-id and it became unchangeable — pinned by Store, VPN and PostHog. The Dometrain course repo does it again with the Stripe `sub_…` id, and the consequence is concrete: cancel and resubscribe issues a *new* subscription id, so the returning customer gets a new tenant and **loses their data** |
| **BV2** | Put the tenant id into names you can't rename — table names, IAM role names, bucket names, schema names | Keep tenant ids in **columns** | The course repo embeds it in a DynamoDB table name, an IAM role name and a Cognito group name. Three renames you can never do |
| **BV3** | Let a tenant id be guessable or sequential if it appears in URLs | Use a slug for URLs, a uuid for the key | `maindomain.com/shop/{tenant_id}` is public surface |

---

## 3. Isolation · `BE`

| # | Don't | Do | Why |
|---|---|---|---|
| **BE1** | Rely on application code remembering a `WHERE tenant_id = …` | **Postgres RLS**, with `set local app.tenant_id` per transaction | A forgotten filter should return nothing, not another tenant's orders. This is the single most valuable rule in the document |
| **BE2** | Let the application role hold `BYPASSRLS` | App role without it; migrations run as the owner | Otherwise the policies are decoration |
| **BE3** | Set the tenant per *connection* | Set it per *transaction*, with `SET LOCAL` | Connection-scoped state and a transaction pooler are a data-leak generator |
| **BI1** | Derive the tenant from a header, host or request body | Derive it from the **token**; the host selects branding only. Token/host mismatch is a 403, not a switch | Host-derived tenancy without a token check is how these systems leak |
| **BI2** | Scope a shopper request by tenant alone, or by subject alone | A shopper reads rows where `tenant_id = <route tenant>` **and** `shopper_sub = <token sub>`. Never one without the other | A shopper's token is deliberately tenant-less, so the tenant comes from the route — which is safe only while the subject condition is also enforced. Staff requests still take the tenant from the token (`BI1`) |
| **BH1** | Build one admin app with an `isStaff` flag | Two apps, two token audiences | "One app with a flag" is how cross-tenant reads ship to production |
| **BH2** | Let a cross-tenant read happen silently | Audit **every** cross-tenant read, with the operator and the reason | Mercury's `StaffOperationLog` instinct, and it matters more here than it did there |
| **BE4** | Enforce isolation in one place and assume it's everywhere | Check each store separately — DB, object storage, search index, cache, queue | The course repo has IAM-enforced isolation on DynamoDB and plain string-matching on the Cognito user directory. Easy to believe you have the strong guarantee everywhere |

---

## 4. Tokens and identity · `CD`

| # | Don't | Do | Why |
|---|---|---|---|
| **CD1** | Hand-roll the IdP once something you don't control must verify your tokens | Run a real OIDC server — discovery, **JWKS with rotation**, asymmetric signing | A remote data plane must verify offline. Hand-rolled is fine while you're the only verifier; it stops being fine here |
| **CD2** | Modify the IdP to fit | Configure it — custom SMS connector, branded login, organizations | A forked IdP is a permanent maintenance tax and, depending on licence, a legal question |
| **BC1** | Issue one fat token listing every membership | Tenant-less **refresh session** + **tenant-scoped access token**; switching tenants mints a new one | A fat token grows with membership, can't be revoked per tenant, and turns one leak into access to every tenant |
| **BC2** | Disable token revocation because it's simpler | Keep revocation on, keep access tokens short | The course repo sets `enableTokenRevocation: false` with 60-minute tokens: a removed employee keeps access for an hour and a leaked token cannot be killed |
| **CD3** | Conflate merchant staff with shoppers | **Organizations are the line.** Staff hold organization membership and tenant-scoped tokens; shoppers are plain users with no organization. Both may live in the IdP | Revised. The original rule kept shoppers out of the IdP on per-MAU pricing grounds — that argument belongs to hosted IdPs and does not apply to a self-hosted one. What still matters is that a shopper never holds a tenant-scoped token |
| **CD4** | Let a data plane trust more than one token issuer | **One issuer, one JWKS.** Federate upstream IdPs *through* ours rather than trusting them directly | Heterogeneous tokens mean every instance carries N issuer configs and offline verification stops being simple. Brokering keeps one key set to cache |
| **BA1** | Assume one user belongs to one tenant | Model `membership` as `(user_id, tenant_id, role)` from day one | The course repo takes the first matching group and therefore cannot express a person who works for two merchants. Retrofitting this is a migration across every table |

---

## 5. One codebase, two modes · `CC`

| # | Don't | Do | Why |
|---|---|---|---|
| **CC1** | Fork a "self-hosted edition" | One image, one code path, `DEPLOYMENT_MODE=pooled\|dedicated` | Everyone who forked this ended up shipping two products with one team |
| **CC2** | Strip `tenant_id` and RLS from single-tenant installs "because there's only one" | Run the dedicated plane as **N=1** with the same schema and the same policies | A second code path is a second test matrix and a first-class source of "works pooled, breaks dedicated" |
| **CC3** | Gate features by build | Gate by **entitlement** in the signed licence | Entitlements are data; builds are not |

---

## 6. The control-plane boundary · `CH`

| # | Don't | Do | Why |
|---|---|---|---|
| **CH1** | Apply "backward compatibility is not a requirement" across the control-plane contract | Keep that policy **inside** the data plane; publish a compatibility window (N-2 releases, or 12 months) for identity, licence and telemetry-ingest APIs | The repo rule is right while every consumer ships together. A data plane running a version you don't control is not that |
| **CG1** | Hard-stop when the control plane is unreachable | Cache JWKS, licence valid offline for N days, buffer telemetry, then **degrade to read-only** | A merchant's shop going dark because your licence server had a bad afternoon ends the tier |
| **CG2** | Leave the offline window undefined | Write down N, the grace period, and what exactly degrades | "It probably keeps working" is not an answer you want to give during the incident |
| **CG3** | Treat "licence says inactive" and "cannot reach the control plane" as one state | Two states, two behaviours: **passive** is the tenant's status and blocks checkout while leaving the dashboard fully usable; **unreachable** is our fault and degrades only after a grace window | Collapsing them means an outage on our side looks to the merchant exactly like being cut off for non-payment, and the path to fix it is the first thing you take away |
| **CK1** | Make tenant provisioning a script someone runs | A named, tested operation — with **deprovisioning and data export** built at the same time | Both get asked for sooner than you expect, and export is usually a contract term |
| **CK2** | Make provisioning a chain of unguarded steps | Idempotent, resumable, with compensation | The course repo's `create-tenant` does CreateTable → CreateRole → PutRolePolicy → CreateGroup with no compensation; any failure leaves a half-made tenant |

---

## 7. Data model

| # | Don't | Do | Why |
|---|---|---|---|
| **BG1** | Write a global unique constraint | Include the tenant: `unique (tenant_id, sku)` | Every uniqueness assumption inherited from a single-tenant schema is wrong now |
| **BG2** | Number orders from a Postgres sequence | Per-tenant counter row taken with `select … for update` inside the order transaction | Sequences leak on rollback, so numbering is neither per-tenant nor gapless. Many jurisdictions require gapless sequential numbering on anything invoice-shaped, and every tenant expects their orders to start at 1 — not at wherever the global sequence happened to be |
| **AM1** | Schedule a job to flip a row's state at a time | Derive the state from its timestamps: `where starts_at <= now() and ends_at > now()` | Mercury's `CampaignEntity.HangfireStartJobId`/`HangfireEndJobId` exist only to do what a predicate does — and carry the bug class where the stored job id drifts from the row |
| **AM2** | Add a queue before there is a side effect to queue | Add **pg-boss** the first time something must *happen* that can't be derived — an email at T+24h, an export, a retryable webhook | Not before |
| **J1** | Hand-edit generated migration SQL | Change the schema, regenerate | Mercury's two migration rules exist because a missing `[Migration]` attribute compiled, deployed and was silently ignored, and a `defaultValue` contradicting an initializer silently deactivated 50 of 61 production users for two months |

---

## 8. Operations and telemetry

| # | Don't | Do | Why |
|---|---|---|---|
| **CI1** | Let PII ride out of a customer's box in a log line | **Scrub at source**; state in the contract exactly what you collect | Shopper names, addresses and phone numbers are personal data under GDPR/KVKK wherever the tenant operates. What you collect from someone else's server is a legal artifact, not just an ops feature |
| **CL1** | Assume platform admin can query every tenant | Design telemetry-derived views for dedicated tenants from the start | Otherwise half your admin screens can't serve your highest-paying tier |
| **CJ1** | Use one metering path for both tiers | Pooled: you measure. Dedicated: they report, signed, with licence-enforced ceilings | See `CE3` |
| **#818** | Use persistent dev containers | Default lifetime, fresh per run | A persistent container is shared by every AppHost on the machine, so a second checkout silently attaches to the same database |

---

## 9. Testing

| # | Don't | Do | Why |
|---|---|---|---|
| **BL1** | Ship without a cross-tenant leak suite | Every fixture seeds **two** tenants; a generated test per table asserts A cannot read/update/delete B | The multi-tenant equivalent of `BannedSymbols.txt`: enforce the invariant mechanically, not by review |
| **CO1** | Test only the happy path of the control-plane link | Stop `identity` and `platform` in the Aspire dashboard and assert the data plane still serves · `CG1` | The offline path is the one you'll need and the one nobody exercises |
| **CO2** | Run only current-version data planes locally | Keep an **N-1** dedicated plane in the AppHost from a pinned image | Version skew is the failure BYOC vendors meet in production |
| **CO3** | Let the trust boundary be a convention | Assert it in the Aspire application model: no dedicated resource references a control-plane database | The AppHost file is the trust-boundary document; make it enforceable |
| **G1** | Enforce conventions in code review | ESLint rules, `--max-warnings 0`, and **ts-morph** for structural rules | Mercury already proved this works with `BannedSymbols.txt` + RS0030-as-error and a Roslyn architecture test |

---

## 10. Carried over from Mercury

| # | Do | Why |
|---|---|---|
| **CR1** | Build a configurable, failure-injecting fake for **every** external dependency, run-mode gated | `fake-bank` is the best idea in the Mercury repo: it lets a developer choose decline / bad hash / no callback / dropped connection, and verifies Mercury's own signature before answering. A fake Stripe for the buy-a-store flow is the direct descendant |
| **S1** | Return one generic code from auth-shaped endpoints — **and log which check actually failed** | Enumeration protection that keeps its diagnostics |
| **AG1** | Keep the rationale in the code, with the issue number | Mercury's comments carry the incident and the reasoning. It is the reason its hard-won rules survived long enough to be written down here |
| **—** | Retire code by git tag, not by leaving dead folders | `v4-portal-final`, `rxtrans-final` |

---

*Companion to [`../README.md`](../README.md). Labels refer to the design discussion; prior art read
so far: Mercury (`mercury@c7f4e009`), [eShop](https://github.com/dotnet/eShop),
[Dometrain multi-tenant SaaS course repo](https://github.com/Dometrain/lets-build-it-multi-tenant-saas-app-in-typescript).*
