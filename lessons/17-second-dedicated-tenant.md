# 17 — a second dedicated tenant, at the same time (phase 3)

## Read first

- Lessons 14, 15 and 16 still hold. `localhost`, never `127.0.0.1`.
- Lesson 16's "`--isolated` is the answer to two Bs at once" is **wrong**, and it is the first
  thing that will cost you an hour. See below.

## `aspire run` stops the other instance of the same AppHost — `--isolated` does not help

The Aspire CLI (13.5.3) treats a running AppHost as a **singleton keyed on the path of its
apphost file**. Every `aspire run` prints `🛑 Stopping previous instance (AppHost PID: …)` and
kills it. Measured three times: B(zenith) → B(orion) killed zenith; both with `--isolated` → same;
second directory with a **symlink** to `apphost.cs` → same.

The CLI's own string says what to do (`strings ~/.aspire/bin/aspire | grep -i isolated`):

> A running instance of this AppHost was found and will be stopped. To run multiple isolated
> instances simultaneously, run from different directories such as git worktree directories.

Two more traps inside that one sentence:

- **A symlink is not a different directory.** The CLI resolves it back to the canonical path.
- **A byte-identical copy is not enough either.** `dotnet run --file` keys its build output on the
  file's CONTENT: `~/.local/share/dotnet/runfile/apphost-<hash>/`. Two identical apphosts share
  one compiled binary directory and the second run rebuilds over the first one's running process —
  which dies with **no message at all**. One trailing comment line naming the tenant is enough to
  separate them (verified: three distinct `apphost-<hash>` directories, one per instance).

`aspire/scripts/run-dedicated.sh <slug> [token]` generates `aspire/AppHostB-<slug>/` from
`aspire/AppHostB/apphost.cs` (plus that marker line), gitignored, rewritten every run.
`--isolated` is still required — it randomises the three CLI ports in `apphost.run.json` — it is
simply not sufficient. `aspire/scripts/stop-dedicated.sh <slug>` stops it from that directory.

## Adding a tenant at run time costs three curls and no code

With the stack already running, and zero edits to AppHost A:

```bash
TOK=$(curl -sX POST $P/dev/login/operator -H 'content-type: application/json' \
      -d '{"subject":"ops"}' | jq -r .accessToken)          # accessToken, NOT token
curl -sX POST $P/tenants           -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
     -d '{"slug":"orion","name":"Orion Instruments","tier":"dedicated"}'
curl -sX POST $P/tenants/orion/activate -H "authorization: Bearer $TOK" -H 'content-type: application/json' -d '{}'
curl -sX POST $P/installations     -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
     -d '{"tenantSlug":"orion","expectedHost":"localhost"}'  # -> bootstrapToken
```

`POST /signup` works too and is the product's front door, but it leaves the tenant `pending` until
a fake-bank round trip settles. `/tenants` + `/tenants/:slug/activate` is the operator path,
issues the licence, and is two calls with no browser.

`expectedHost` MUST be `localhost`: Aspire renders every endpoint host as `localhost`, the box
reports what Aspire gave it, and the pin is a string compare.

## The organization blocker, and where it actually was

`packages/identity/src/bootstrap.ts` defaults `IDENTITY_TENANT_SLUGS` to `acme,borg,zenith`, so a
tenant bought after AppHost A started has **no Logto organization** — and `provision()` only
looked one up, so the instance got `organizationId: null` and could never recognise its own
merchant as staff. The fix is `ensureOrganizationBySlug` (create on miss) called from
`apps/platform/src/identity.ts`, NOT teaching AppHost A the slug list: the second choice puts back
exactly the advance knowledge v2.0.0 deleted. Verified: `GET /api/organizations` listed `orion`
right after registration, and `.instance/orion.json` carried its id.

**Remember lesson 16's trap while doing this**: the platform process holds `@mercatus/identity`
and runs under AppHost A. Editing `packages/identity/*` and restarting only B does nothing.

## Cookies ignore the port, and the fourth shop is where that finally bites

Three storefronts on `http://localhost:<port>` are **one cookie jar**. `mercatus_shopper` is
`Path=/`, host-only, and a host-only cookie does not care about the port — so signing the shopper
in at the second storefront overwrites the first one's token, and since phase 2 gave every box its
own `AUTH_STUB_SECRET` (`CE1`, and right to), the leftover token is one the other store refuses.

The symptom is not a sign-in failure. It is a checkout page that still says **"Buying as +90…"**
— the readable phone cookie belongs to the same person, whoever minted it — with
`UNAUTHENTICATED: Not authenticated.` under it and a Pay button that does nothing. The e2e
sign-in helper made it worse: its success condition was "the phone cookie names our shopper",
which another storefront had already satisfied, so it returned without ever minting a token here.

Fix, in three places: a dedicated instance is driven at `<slug>.localtest.me:<port>`
(`packages/e2e/tests/helpers/stack.ts`, one line of URL rewriting — `*.localtest.me` is loopback
with no `/etc/hosts`), `signIn` clears **that host's** cookies before it starts (`helpers/shop.ts`),
and `'*.localtest.me'` goes in `allowedDevOrigins` (`apps/storefront/next.config.ts`).

**And `context.cookies()` with no argument is the whole jar.** The sign-in helper polled it for
`mercatus_shopper_phone`, which every storefront sets to the same person, so the answer was `yes`
before this store had minted anything. `context.cookies(storefrontUrl)` asks the question that was
meant. This is the bug that made the hostname change look like it had not worked.

**That third one costs a whole cycle if you miss it**, and the existing comment in that file
describes the symptom exactly: `next dev` refuses the dev-only requests hydration needs from an
origin it was not told about, so the page renders, the form takes the keystrokes, and **the click
does nothing**. There is no error in the browser console — the one line that says why is in the
dev server's own log. A bare `localtest.me` does NOT cover `zenith.localtest.me`; Next matches
patterns label by label (`*` one label, `**` several, a bare `*` refused), so the entry has to be
`*.localtest.me`. Changing `next.config.ts` needs the dev server restarted, which here means
restarting the AppHost B it belongs to.

## What is still missing for a runtime-created tenant

`ensureOrganizationBySlug` creates the organization and nothing else. The bootstrap also makes a
`<slug>_owner` user and gives it the `owner` role in that organization; a tenant created through
the API has **no staff user at the issuer**. Under `AUTH_ADAPTER=stub` (the default, and what the
e2e suite drives) that is invisible — the dashboard signs in by slug. Under `oidc` a new tenant's
merchant has no way in. Same family as lessons/14 and /15's "the browser UIs have no OIDC path".

## The suite is re-runnable in its arithmetic, not in its STOCK

`01` buys one `Rocket Skates` (ACM-002, seeded with a handful) on every run, and the run that
takes the last one leaves any later spec that names that title failing on a perfectly healthy
stack — `Add to basket` is simply not on the card any more, so the click loop times out with no
error worth reading. `04` asks the store API for something with `stock > 0` instead of naming a
product. A fresh `aspire run` of AppHost A re-seeds, because its Postgres is a container with no
persistence, so this only bites within one stack's lifetime.

## Timings, warm machine, four tenants

- AppHost A: `/health` green and `.identity/management.json` fresh in **~15 s** from `aspire run`.
- AppHost B, either instance: store `/health` in **~10 s**; the second one is not slower.
- Both dedicated boxes notice a dead control plane and reach `grace` within one poll window
  (`LICENCE_POLL_SECONDS=5`), independently.
- Full e2e suite with two pooled and two dedicated tenants: **22 tests, ~2 min**.
