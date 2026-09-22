# 17 — a second dedicated tenant (v2.0.0, phase 3)

Started at `106a39b` (phase 2). The job: add **orion** as a second dedicated tenant with zero
edits to AppHost A, and prove it with four merchants serving at once.

## What I did

### 1. The organization blocker, fixed where it belonged

Phase 2's note was right: `packages/identity/src/bootstrap.ts` defaults `IDENTITY_TENANT_SLUGS`
to `acme,borg,zenith`, and `IdentityProvisioner.provision()` only *looked up* an organization. So
a tenant that did not exist when AppHost A started registered with `organizationId: null`.

The brief offered two roads and said which one keeps the claim true. I took that one:
`ensureOrganizationBySlug` in `packages/identity/src/applications.ts`, called from
`apps/platform/src/identity.ts` on the registration path. The control plane creates the
organization when the issuer has never heard of the tenant — idempotent, and a race that loses to
Logto's unique name looks again instead of throwing. **AppHost A was not touched.**

Verified against the live issuer: `GET /api/organizations` lists `orion` (`vn8mkqoc2nne`), and
`.instance/orion.json` carries it.

### 2. orion was bought, not seeded

Three calls against a running control plane, no code, no restart:

```
POST /dev/login/operator {"subject":"phase3"}                       -> accessToken
POST /tenants   {"slug":"orion","name":"Orion Instruments","tier":"dedicated"}   -> pending
POST /tenants/orion/activate {}                                     -> active + licence
POST /installations {"tenantSlug":"orion","expectedHost":"localhost"} -> bootstrapToken
```

`seed-dedicated.ts` was left alone on purpose: a seed row per tenant is exactly the per-tenant
edit v2.0.0 exists to delete.

### 3. The wall: two AppHost Bs at once

`aspire run` **stops the running instance of the same apphost file**, `--isolated` and all. Phase
2 assumed `--isolated` was enough; it is not, and the README said so too. Three measurements, then
the CLI binary's own string gave the answer: *"run from different directories"*.

`aspire/scripts/run-dedicated.sh <slug> [token]` generates `aspire/AppHostB-<slug>/` from
`aspire/AppHostB/apphost.cs` on every run (gitignored, one source of truth) and runs it there with
`--isolated --detach`. `stop-dedicated.sh <slug>` stops it. Two traps cost a cycle each and are in
`lessons/17`: a symlink is resolved back to the canonical path, and a byte-identical copy shares
`dotnet run --file`'s content-keyed build directory — the second run tears down the first one's
binary with no message at all. Hence the generated file's trailing `// GENERATED … for tenant
'<slug>'`, which is what makes it a different application to build.

### 4. The defect the fourth shop found

With four merchants and three storefronts, orion's checkout button did nothing: the page said
"Buying as +90…" and, under it, `UNAUTHENTICATED`. **Cookies are host-scoped and ignore the
port**, so `localhost:15981` (zenith) and `localhost:13614` (orion) are one jar — and phase 2
correctly gave every box its own `AUTH_STUB_SECRET`, so the surviving token is one the other store
refuses. The e2e sign-in helper hid it: its success condition was "the phone cookie names our
shopper", which the previous storefront had already satisfied.

Fixed by giving each box the hostname a real deployment would have given it: a dedicated instance
is driven at `<slug>.localtest.me:<port>` (`packages/e2e/tests/helpers/stack.ts`), `signIn` clears
that host's cookies first (`helpers/shop.ts`), and `'*.localtest.me'` is allowed in
`apps/storefront/next.config.ts`. The third one cost a cycle on its own: without it `next dev`
refuses the requests hydration needs and the sign-in button silently does nothing — which is the
symptom the comment already in that file describes, for `127.0.0.1`.

### 5. Two more defects the fourth shop found, both in the suite

- **`context.cookies()` with no argument is the whole jar.** The sign-in helper polled it for
  `mercatus_shopper_phone`, which every storefront sets to the same person, so it answered "signed
  in" before this store had minted anything — and returned with the click dropped. Scoped to the
  storefront's own URL now.
- **The suite was re-runnable in its arithmetic but not in its STOCK.** `01` buys one
  `Rocket Skates` per run; the run that takes the last one leaves every spec naming that title
  timing out on a healthy stack, because the card simply has no `Add to basket` button any more.
  `sellableProduct(storeApi, slug)` now lives in `helpers/stack.ts` and `01`, `03` and `04` all
  ask the store what it still has (it also de-duplicates the copy `03` and `04` each had).

### 6. The gate as a spec

`packages/e2e/tests/04-two-dedicated-tenants.spec.ts`, which skips unless BOTH dedicated instances
are publishing an address book.

## The sequence that runs it

```bash
cd aspire/AppHostA && aspire run --detach --non-interactive --nologo --format Json
# wait for platform.localtest.me:28080/health {"status":"ok"}, .identity/management.json, and
# Logto's /oidc/.well-known/openid-configuration -> 200        (~15 s, warm)

P=http://platform.localtest.me:28080
TOK=$(curl -sX POST $P/dev/login/operator -H 'content-type: application/json' \
      -d '{"subject":"phase3"}' | jq -r .accessToken)
curl -sX POST $P/tenants -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
     -d '{"slug":"orion","name":"Orion Instruments","tier":"dedicated"}'
curl -sX POST $P/tenants/orion/activate -H "authorization: Bearer $TOK" \
     -H 'content-type: application/json' -d '{}'
BOOT=$(curl -sX POST $P/installations -H "authorization: Bearer $TOK" \
       -H 'content-type: application/json' \
       -d '{"tenantSlug":"orion","expectedHost":"localhost"}' | jq -r .bootstrapToken)

cd aspire/AppHostB && MERCATUS_TENANT_SLUG=zenith aspire run --isolated --detach --non-interactive --nologo --format Json
aspire/scripts/run-dedicated.sh orion "$BOOT"

pnpm test:e2e

# down
cd aspire/AppHostB && aspire stop --non-interactive --nologo
aspire/scripts/stop-dedicated.sh orion
cd aspire/AppHostA && aspire stop --non-interactive --nologo
```

## State I left

- `git diff v1.0.0 --stat` is phase 0–3; nothing from v1.0.0 removed that was not planned.
- AppHost A untouched by this phase (`git diff 106a39b -- aspire/AppHostA` is empty).
- Both AppHosts and both dedicated instances stopped, containers reaped, `chess-trainer` left
  alone (not ours).
- `aspire/AppHostB-orion/` is generated and gitignored; it is not in the commit.
- Still open, and not this phase's: a tenant created at run time gets an organization at the
  issuer but **no staff user or membership**, so its merchant cannot sign in under
  `AUTH_ADAPTER=oidc`. The three browser UIs still have no OIDC path at all (lessons/14, /15).
