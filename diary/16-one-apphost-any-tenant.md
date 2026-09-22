# 16 — one AppHost B, any tenant (v2.0.0 phase 2)

Baseline: `93fd588` (phase 1). Gate: `MERCATUS_TENANT_SLUG=zenith` reproduces today's behaviour
with the whole e2e suite green. **16/16, twice, on two separate fresh stacks.**

## What the phase was

Phase 1 deleted the fixed port. Phase 2 deletes the *copy*: there is one AppHost B and it serves
whichever tenant `MERCATUS_TENANT_SLUG` names.

Everything per-tenant in `aspire/AppHostB/apphost.cs` now derives from that one string —
`api-store-tenant-{slug}`, `web-storefront-tenant-{slug}`, `web-dashboard-tenant-{slug}`,
`pg-tenant-{slug}`, `db-tenant-{slug}`, `task-migrate-tenant-{slug}`,
`task-provision-tenant-{slug}`, `.instance/{slug}.json`, `.identity/store-{slug}.json`,
`.next-{slug}`, `.stack/apphost-{slug}.json`, the stub and session secrets, and the dev bootstrap
token (`mercatus-dev-bootstrap-token-for-{slug}-001`, which is what `seed-dedicated.ts` already
seeds). The slug is validated against `^[a-z][a-z0-9-]{1,38}$` before any of that, because it
becomes a container name and a file path. `zenith` is the default, so a bare `aspire run` is
unchanged.

**`TenantName` is gone rather than parameterised.** "Zenith Tools" cannot be derived from
"zenith", and it did not have to be: the control plane owns the name. `registerInstallationResult`
now carries `tenantName`, the install command mirrors that (`BV1`), and the AppHost holds no name
at all. Verified on the wire — `.instance/zenith.json` came back with `"tenantName": "Zenith
Tools"` and `/t/zenith/branding` still answers `"name":"Zenith Tools"`.

**The address book is keyed per instance, not per AppHost.** `write-stack-manifest.mjs` takes an
optional `MERCATUS_MANIFEST_TENANT` and writes it as a top-level `tenant`; the endpoint keys inside
became unqualified (`store`, `storefront`, `dashboard`). `packages/e2e/tests/helpers/stack.ts`
globs `.stack/apphost-*.json`, merges every file WITHOUT a tenant into the control-plane half, and
exposes the rest as `DEDICATED[slug]` / `dedicated(slug)`. `global-setup.ts` builds its optional
list from whatever it finds instead of naming zenith, and `03-dedicated-outage.spec.ts` resolves
zenith through `dedicated('zenith')`.

**The Aspire CLI's own three ports** (`15240`, `19081`, `20015` in `apphost.run.json`) are not
parameterised, because `aspire run --isolated` already exists and randomises exactly those. Run
once against AppHost B on its own: the dashboard came up on **41171**, and `aspire stop` reaped it
from the same directory. Two Bs side by side is phase 3's to prove.

## The audit findings

B, C, D, E and F were all still present. All five are fixed, and C and E are confirmed fixed
against a live Logto rather than only in a test.

- **B — normalisation.** `normaliseReportedUrl()` (`apps/platform/src/identity.ts`) is now the
  single spelling: `parsed.origin + parsed.pathname`, trailing slashes stripped, and userinfo, a
  query and a fragment REFUSED rather than stripped. The route stores the normalised string and
  hands the same string to Logto, so what was validated is character-for-character what the
  issuer gets. `callbacks()` normalises again, so a row written before this cannot register one
  spelling and deregister another.
- **C — an instance that moves.** `POST /installations/report` (instance token, host-pinned
  exactly as registration is) and a `report()` call in `apps/store/src/provision.ts` on every boot
  where the cached credential is accepted. **Proved:** restarted B alone, it moved
  `27550 → 15509`; `GET /installations` followed it; probing `/oidc/auth` with the instance's own
  client_id gave **303 for the live address and 400 (`oidc.invalid_redirect_uri`) for the old
  one** — the exact inverse of the audit's transcript.
- **D — deprovisioning someone else's URI.** `listOtherInstallations()` feeds
  `SharedUriOwnership` into both provision and deprovision; a URI another installation still
  reports is never removed. Covered by a test that registers a second installation at the live
  one's dashboard address and deletes it.
- **E — the lists grow for ever.** `reconcileRedirectUris()` replaces `addRedirectUris` /
  `removeRedirectUris` and does add-and-remove in ONE read-modify-write; the instance's own
  application is written AUTHORITATIVELY rather than unioned (it has exactly one owner).
  **Proved:** after the restart above, every one of the five applications holds the new port and
  none of them holds the old one. The first attempt at this failed and it was instructive — see
  lessons.
- **F — the orphaned client.** `provision()` takes an `onApplicationCreated` callback and the
  route writes `logtoApplicationId` the moment the client exists, before anything else can throw.
  A failure after that point is a `warnings[]` entry in our log, and the instance is still handed
  its `oidc` block instead of being told `null` and silently coming up with no OIDC.

**K's suggestion taken:** `apps/platform/test/registration.test.ts` — 14 tests against a real
HTTP fake of the Management API (client-credentials token, applications list, a PATCH that
REPLACES `redirectUris`, a `failPatchFor` switch and a PATCH counter). It covers all five findings
plus idempotency asserted as a count of zero PATCHes. `pnpm -r test` is **261**, up from 244.

## Gate transcript

```
A ready in 5s; logto /oidc/.well-known/openid-configuration -> 200
B (MERCATUS_TENANT_SLUG=zenith) ready in 11s -> .stack/apphost-zenith.json
  {"tenant":"zenith","endpoints":{"dashboard":"…:27552","store":"…:27550","storefront":"…:27551"}}
pnpm test:e2e -> "AppHost A is up, and so is every dedicated instance (zenith)."
             -> 16 passed (42.2s)
pnpm turbo run typecheck lint -> 26/26
pnpm -r test -> 261 passed, 0 skipped
```

## What is left, and for whom

- Phase 3's `orion` still needs a tenant row of tier `dedicated` and a Logto organization named
  after the slug. `packages/identity/src/bootstrap.ts:99` still hard-codes
  `IDENTITY_TENANT_SLUGS='acme,borg,zenith'` and AppHost A never overrides it — finding L, still
  open, still phase 3's. This phase did not touch it.
- `aspire run --isolated` randomises the three CLI ports (checked: dashboard on 41171). Two
  AppHost Bs at the SAME time has not been run — phase 3's first command.
- The e2e suite still drives `AUTH_ADAPTER=stub`, so the OIDC work above is verified by
  `list-applications.sh` and by probing `/oidc/auth`, not by the browser suite. Unchanged from
  phase 1, and still its own task.
