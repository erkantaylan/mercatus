# 18 — repair round 1

Acceptance failed v2.0.0 on ten findings. The blocker was not a bug in anything that ran; it was
that the plan's definition of done could not be satisfied by any single topology.

## What was actually wrong

`MERCATUS_AUTH_ADAPTER=oidc` put the STORE API on a real issuer and left both browser front ends
unable to sign anybody in, on both planes. `apps/storefront/lib/session.ts` minted the shopper's
token by POSTing `${store}/dev/login/shopper`; `apps/dashboard/src/api/client.ts` did the same at
`/dev/login/staff`. Both routes are registered only when the adapter is the stub
(`apps/store/src/routes/dev-login.ts` returns early otherwise), so the storefront answered **502**
and the dashboard **404**. Lessons 14, 15 and 17 each end with a paragraph saying so; nobody had
closed it because it reads like a front-end chore and is actually the shape of the whole auth
seam.

The consequence is the one acceptance named: "two pooled tenants, two dedicated tenants, real
OIDC on both planes, one shopper account across all of them" was never simultaneously true. The
four-tenant shopping demo existed on the stub; real OIDC existed in a shell script with no
shopping and no dashboards.

## What I built

**The store is now the only OIDC client in the topology**, and both front ends sign in through
its own `/auth/*`. That was the design decision the rest followed from. The alternative — a client
per front end — was rejected twice over: a dashboard is a bundle served to a browser and a secret
in one is not a secret, and a per-instance client secret in the storefront would put a second
credential on a box whose owner has root (`CE1`).

- `GET /auth/login?via=store|storefront|dashboard` picks which of the three registered redirect
  URIs the issuer sends the code back to. `via=store` is the old behaviour, so the two shell
  gates in `packages/identity/scripts` are untouched.
- `POST /auth/exchange` returns the store's own session as a TOKEN, for a front end on another
  origin that cannot be sent a host-only cookie.
- `packages/core/src/auth/plugin.ts`: a bearer the adapter rejects is retried against the store's
  `SessionIssuer`. Same credential as the cookie, different transport, no new trust boundary.
- `GET /dev/login` is the stub's sign-in PAGE. `StubAuthAdapter.authorizeUrl()` has pointed at
  that address since task 03 and nothing ever served it — which is exactly why both front ends
  called the POST routes directly. Plain server-rendered HTML, no script, so a browser driver
  cannot click it before it works.
- `apps/storefront`: `/api/auth/login` and `/api/auth/callback` (the URI the platform was already
  registering), an httpOnly cookie holding the store's session, and no guest checkout — there is
  no way to mint a session without the issuer any more, and a phone was never an identity.
- `apps/dashboard`: a `/callback` route and one auth adapter instead of a stub one.
- `packages/identity` + `apps/platform`: all three callbacks go on the STORE's client, pooled and
  dedicated alike.

Then three things that were in the way of demonstrating it:

- **A hostname per dedicated instance.** AppHost B publishes `<slug>.localtest.me:<aspire port>`
  for all three browser-facing surfaces. Phase 3 had solved the shared-cookie-jar collision inside
  the e2e helper; once those addresses are registered redirect URIs, a rewrite there sends the
  shopper somewhere the issuer was never told about. `expectedHost` follows.
- **orion is seeded.** `aspire stop` on AppHost A destroys A's Postgres, so a rebuilt control
  plane forgot orion's installation and the operator paid four curls again, with a stale
  `.instance/orion.json` left over. Both dedicated slugs are now seeded, so the four-tenant
  topology is one command per box.
- **A runtime-created tenant gets a `<slug>_owner` user at the issuer**, not only an
  organization. Under the stub this was invisible; under `oidc` orion's merchant had no account
  at all.

## What I fixed in the tests

`04-two-dedicated-tenants.spec.ts` opened every test with `test.skip(!bothUp, …)`, so the
everyday one-box loop reported the file green having proved none of its five claims. The run now
DECLARES what it is claiming (`MERCATUS_E2E_DEDICATED`, default `zenith,orion`); a claimed
instance that is not answering fails global setup, and the only route to a skip is to have
narrowed the variable on the command line, which the skip reason quotes back. `03` is the same
shape.

`05-oidc-four-tenants.spec.ts` is new and is the demonstration acceptance said was missing: one
account signs in at Logto ONCE, buys at all four shops across three origins, the subject is the
same string at every one of them, and four merchants sign in at four dashboards through the same
issuer. It detects the adapter from where `/auth/login` redirects;
`MERCATUS_E2E_REQUIRE_OIDC=1` makes a skip a failure.

## The state I am leaving

- `pnpm turbo run typecheck lint` — 26/26.
- `pnpm -r test` — 261, 0 skipped.
- `pnpm test:e2e` on the stub, against two pooled and two dedicated tenants — 22/22 in 1.6 min.
- `05-oidc-four-tenants.spec.ts` on `MERCATUS_AUTH_ADAPTER=oidc`, against the same four tenants —
  the result is in the commit message, measured, not claimed.
- Versions bumped to **2.0.0** in the root and all 14 workspace packages, so a registered instance
  reports `version: "2.0.0"` to the platform console. Tagged `v2.0.0`. Not pushed; the human
  pushes.
- `docs/MORNING.md` §1–§3 rewritten. It was the file that opens with "Read this file" and it still
  told a reader to buy on `http://127.0.0.1:3002`, an address that has not existed since the
  dedicated store's port became Aspire-assigned.
- `REQUIREMENTS.md`'s container table now names the containers that exist.
- `docs/OPEN-DEFECTS.md` has a new section, "Still shipping at v2.0.0", naming EV, EW, EX, CE2 and
  EY with what each costs. None of them is fixed and the release is being handed over with them.

## What I did not do

- **EV, EW, EX, CE2, EY.** Out of scope for a repair round whose blocker was the auth seam. They
  are stated in one place with file paths rather than implied.
- **Specs 01–04 under `oidc`.** They mint a fresh shopper per run, and under a real issuer that
  needs a Logto user created per run through the Management API. `05` covers the same ground with
  the seeded account, which is the claim that was missing; making the other four adapter-aware is
  a bigger change than it looks and would have bought a second copy of the same evidence.
- **`pnpm -r test` still does not include the browser suite.** `packages/e2e` has no `test`
  script, deliberately: turbo would replay a cached green against a stack that is no longer up.
