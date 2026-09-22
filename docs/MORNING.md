# Morning

**Read this file first.** It is the entry point: how to start the whole thing, what the demo is,
what is verified, and what is still broken. Then `docs/decisions-made-overnight.md` for the full
list of judgement calls, then `lessons/` if you are about to write code.

This is **v2.0.0**, and it is a different topology from v1.0.0. Two pooled tenants and **two**
dedicated ones run at once; every port but three is assigned by Aspire at run time, so there is no
table of ports to read and every address is looked up; and both browser front ends sign in through
the store's own OIDC round trip, so the stack runs on a **real issuer** with shopping and
dashboards working, not only on the stub.

Everything in **What works** was measured on this machine during the run that produced this file.
Nothing here is inherited from an agent's own report.

---

## 1. Run it

```bash
cd ~/Desktop/projects/mercatus
pnpm install                       # ~3s warm

# A -- control plane, identity (Logto), fake-bank, the POOLED store serving acme and borg,
#      the storefront, the merchant dashboard, the platform console, and Traefik on 28080
( cd aspire/AppHostA && aspire run --detach --non-interactive --nologo --format Json )

# B, twice -- two dedicated boxes, each with its own Postgres, its own store process and its
#             own hostname. One command each; no token, no curl.
aspire/scripts/run-dedicated.sh zenith
aspire/scripts/run-dedicated.sh orion
```

A is ready in ~15 s and each B in ~10 s more. `--detach` is not optional: without it the command
never returns.

`run-dedicated.sh` exists because the Aspire CLI treats a running AppHost as a singleton keyed on
the path of its apphost file — a second `aspire run` on `aspire/AppHostB/apphost.cs` stops the
first, `--isolated` and all. The script generates `aspire/AppHostB-<slug>/` from that one file
(gitignored, rewritten every run) so two can serve at once.

### Where everything is

**Nothing but the edge and identity has a port you can write down.** Every service port is
Aspire-assigned, so each AppHost publishes its own half of the address book as it starts:

```bash
cat .stack/apphost-a.json        # platform, store_pooled, bank, storefront, dashboard, admin, edge
cat .stack/apphost-zenith.json   # store, storefront, dashboard -- and the tenant they serve
cat .stack/apphost-orion.json
```

A's surfaces are also reachable through the edge on **28080**, which is the one set of addresses
worth typing. A dedicated box answers on a hostname of its OWN — `<slug>.localtest.me:<port>`,
which resolves to loopback with no `/etc/hosts` entry — because cookies are scoped by host and
ignore the port, so several storefronts on `localhost` would share one cookie jar.

Readiness, in one loop, addresses read rather than assumed:

```bash
E=${MERCATUS_EDGE_PORT:-28080}
for u in http://platform.localtest.me:$E/health \
         http://api.localtest.me:$E/health \
         http://bank.localtest.me:$E/health \
         http://shop.localtest.me:$E/t/acme \
         http://dash.localtest.me:$E/ \
         http://console.localtest.me:$E/ \
         "$(jq -r .endpoints.store      .stack/apphost-zenith.json)/health" \
         "$(jq -r .endpoints.storefront .stack/apphost-zenith.json)/t/zenith" \
         "$(jq -r .endpoints.store      .stack/apphost-orion.json)/health" \
         "$(jq -r .endpoints.storefront .stack/apphost-orion.json)/t/orion"; do
  printf '%s -> %s\n' "$u" "$(curl -s -o /dev/null -m 4 -w '%{http_code}' "$u")"
done
```

All ten answer 200. And back down — the dedicated boxes first, so their credentials stay valid:

```bash
aspire/scripts/stop-dedicated.sh orion
aspire/scripts/stop-dedicated.sh zenith
( cd aspire/AppHostA && aspire stop --non-interactive --nologo )
docker ps                        # should show nothing of ours
rm -f .stack/apphost-*.json      # aspire stop does NOT remove these; stale ones cost the e2e
                                 # suite a 90 s timeout instead of one sentence
pgrep -af 'aspire-managed nuget' # the CLI leaves one per generated run directory; kill by pid
```

### The demo, step by step

Addresses below are the edge's, plus two `jq` lookups for the dedicated boxes:

```bash
E=${MERCATUS_EDGE_PORT:-28080}
ZEN=$(jq -r .endpoints.storefront .stack/apphost-zenith.json)
ORI=$(jq -r .endpoints.storefront .stack/apphost-orion.json)
```

1. **Shop.** `http://shop.localtest.me:$E/t/acme` → **Sign in** → you are sent to the ISSUER and
   brought straight back. Under the default stub adapter that is the store's own dev page, which
   asks for a phone and no password; under `oidc` it is Logto. Add to basket, check out. You are
   handed fake-bank's hosted page (it opens on the bank's direct address — see **EW**), click
   **approve**, then browser **Back**: the checkout page's `pageshow` handler takes you to the
   confirmation, which says `paid`.
2. **Buy from the second shop** at `/t/borg` without signing in again. Same account, one order at
   each store — that is `Q20` and `BI2` working.
3. **Merchant.** `http://dash.localtest.me:$E` → enter slug `acme` → **Sign in**, which is the
   same round trip. The order is there with a Payment column. `borg`'s orders are not, and cannot
   be reached.
4. **Operator.** `http://console.localtest.me:$E` → sign in → flip `acme` to **passive**. Within
   one poll (5 s) the storefront refuses checkout and keeps browsing open; the dashboard stays
   fully usable. Flip it back.
5. **The flagship.** Buy at `$ZEN/t/zenith` and at `$ORI/t/orion` — two customer-owned boxes, two
   databases, two ports nobody chose. Then kill our whole control plane:

   ```bash
   ( cd aspire/AppHostA && aspire stop --non-interactive --nologo )
   ```

   Buy again, at both. The orders are placed, numbered and priced; only the payment waits (202 —
   payments are ours and never run on a customer's server, `CE2`). Browsing stays 200 throughout.
   After `LICENCE_GRACE_SECONDS` — 60 s here, 72 h by default — checkout degrades to **503
   `CONTROL_PLANE_UNREACHABLE`** and the dashboards go read-only.

   **To recover you must restart the dedicated boxes as well as A** (**EV**): `aspire stop` on A
   destroys A's Postgres, so the rebuilt control plane has never heard of either installation.

   ```bash
   ( cd aspire/AppHostA && aspire run --detach --non-interactive --nologo --format Json )
   aspire/scripts/stop-dedicated.sh zenith && aspire/scripts/run-dedicated.sh zenith
   aspire/scripts/stop-dedicated.sh orion  && aspire/scripts/run-dedicated.sh orion
   ```

   Both re-register on start, `GET /installations` goes back to `total: 2`, and each store is
   `active/healthy` with `checkout: open` on the next poll.

6. **A THIRD dedicated tenant, with zero edits to AppHost A.** `zenith` and `orion` are seeded
   into the control plane's database so the dev loop needs no token; any other slug is four
   authenticated calls and then one command. The full recipe is in the README and in the header of
   `aspire/scripts/run-dedicated.sh`.

### The three checks

```bash
pnpm -r test                    # 261 tests, 0 skipped, ~35s. No stack needed.
pnpm turbo run typecheck lint   # 26/26
pnpm test:e2e                   # 22 Playwright tests in real Chrome, ~1.6 min, against the live
                                # four-tenant topology. Needs AppHost A and BOTH dedicated boxes.
```

`pnpm test:e2e` **fails** — it does not skip — if a dedicated instance it is claiming is not
running. What it claims is `MERCATUS_E2E_DEDICATED`, default `zenith,orion`; narrowing it is an
explicit act that the skip reason quotes back at you.

### The same demo on a REAL issuer

The default adapter is the stub, and everything above works on it. Switching to Logto changes
nothing about how the front ends sign in — that is the whole of the v2.0.0 repair — so the same
topology runs on a real issuer:

```bash
# stop everything first, then -- note the export: `VAR=x ( ... )` is a bash SYNTAX ERROR, and this
# block used to be written that way.
export MERCATUS_AUTH_ADAPTER=oidc
( cd aspire/AppHostA && aspire run --detach --non-interactive --nologo --format Json )
aspire/scripts/run-dedicated.sh zenith
aspire/scripts/run-dedicated.sh orion

MERCATUS_E2E_REQUIRE_OIDC=1 pnpm test:e2e     # tests/05-oidc-four-tenants.spec.ts
```

`05-oidc-four-tenants.spec.ts` signs one account in at Logto ONCE, buys at all four shops across
three origins, checks the subject is the same string at every one of them, and signs four
merchants in at four dashboards. It DETECTS the adapter from where `/auth/login` redirects, so it
skips on the stub and says which command turns that around; `MERCATUS_E2E_REQUIRE_OIDC=1` makes
that skip a failure, which is what an acceptance run should use.

Plus two single-purpose gates worth knowing about:

```bash
MERCATUS_LEAK_SABOTAGE=products pnpm --filter @mercatus/db-store test   # must go RED
packages/identity/scripts/shopper-sso-across-planes.sh <pooled> <dedicated> <logto>
```

---

## 2. What works — measured, not claimed

| | Evidence |
|---|---|
| `pnpm -r test` | **261 passed, 0 skipped**, exit 0. core 26, contracts 25, db-platform 11, fake-bank 17, platform 39, db-store 98, store 45 |
| `pnpm turbo run typecheck lint` | 26 tasks, 26 successful |
| `pnpm test:e2e` (stub) | **22 passed, 6 skipped, 1.6 min**, real Chrome, headless, against two pooled and two dedicated tenants live |
| `MERCATUS_E2E_REQUIRE_OIDC=1 pnpm test:e2e` | **6 passed, 22 skipped, 50.7 s** — the four-tenant demo in a browser on Logto: one account signing in once, four shops, three origins, four dashboards |
| Every instance reports **`version: "2.0.0"`** | observed live in `GET /installations` for both zenith and orion |
| AppHost A | up in ~15 s; six edge hostnames 200; Logto `/api/status` 204 |
| Two dedicated boxes | one command each, ~10 s each, registered with the control plane at Aspire-assigned ports and hostnames of their own |
| Host pinning | a `baseUrl` on another host is refused with a generic 401 and does NOT burn the bootstrap token; the same token then registers on the pinned host |
| Tenant isolation | 98 db-store tests, including the F1 composite-FK attack cases, against a real Postgres per run |
| Deprovisioning | `DELETE /installations/:id` → 204, and that instance's Logto client is gone (`CK1`) |
| Cleanup | after stopping all three AppHosts, `docker ps` shows only `chess-trainer` and none of our ports are held |

The five headline claims, honestly graded:

1. **Tenant isolation that isn't a `WHERE` clause** — yes. RLS, forced, tenant from the token, a
   suite that has been *seen to fail* under `MERCATUS_LEAK_SABOTAGE`, and a grep test that fails
   the build if application code writes `where tenant_id`.
2. **One image, two deployment modes** — yes. The same `apps/store` source runs pooled on A and
   dedicated on B, one environment variable apart.
3. **Centralised identity** — **yes, in a browser, on both planes, as of v2.0.0**. Until this
   release the storefront and the dashboard could only mint tokens through `/dev/login/*`, which
   exists solely under `AUTH_ADAPTER=stub`: turning the real issuer on turned sign-in off, and
   "real OIDC" was demonstrable only by a curl script with no shopping and no dashboards. Both
   front ends now go through the store's own `/auth/*`, and the store is the only OIDC client in
   the topology.
4. **Graceful degradation** — yes, and it is still the best thing in the build. Caveat in **EV**.
5. **Failure injection for payments** — yes. `approve` / `decline` / `bad-hash` / `no-callback` /
   `drop`, chosen from a query parameter or the hosted page.

---

## 3. What does not work

No optimism in this section. The full table, with file paths and what each one costs, is
`docs/OPEN-DEFECTS.md` under "Still shipping at v2.0.0". In one line each:

- **EV** — a *running* dedicated box never recovers when the control plane is rebuilt;
  re-registration happens only at its start. Restarting it fixes it in one poll.
- **EW** — one port covers HTML and nothing else: every SPA XHR and the whole payment leg leave
  the edge.
- **EX** — CORS is `origin: true, credentials: true` on every API, which is also what keeps EW
  invisible.
- **CE2** — the storefront signs fake-bank requests itself, including on a box whose owner has
  root. `POST /payments/proxy` was never built. This is the one a security reviewer finds first.
- **EY** — the merchant cannot see who bought; the data is in the store and the gap is in the
  dashboard.
- **EZ**, narrowed — the OIDC path now has browser coverage (`05-oidc-four-tenants.spec.ts`), but
  `pnpm -r test` still contains none of the browser suite, so the headline command is not the
  headline check.

Still open and unchanged from the RLS verifier: **F4** (no RLS on the control plane — fine while
the only consumer is the operator console), **F5**, **F6**. Not built: tier 2 custom domains,
`POST /payments/proxy`, a payments screen in the console, a screen for issuing bootstrap tokens.

**Git.** The repo is ahead of `origin/develop` and unpushed. The standing instruction to every
agent was NEVER push, and there is a real remote. Your call, not ours.

---

## 4. Decisions taken overnight that you should look at

The full list is `docs/decisions-made-overnight.md`, one bullet per decision, newest at the bottom.
These are the ones where an agent chose something you might have chosen differently. Mechanical
version pins are not repeated here.

### Contradicts a design doc

| Decision | Reason |
|---|---|
| **Dashboard and console are Vite + React + TanStack Router SPAs, not TanStack Start; plain CSS tokens, not Fluent UI v9** | the standing decisions for the build overrode the README's stack table. The README's table is still the old text — it is the one place the docs and the code disagree, and it is deliberate |
| **`packages/clients` was never built; no Orval, no Kubb, no generated client** | `packages/ui` took its slot in the layout. Each app has a ~40-line typed fetch wrapper that parses with the Zod contracts. Codegen is a toolchain to debug at 3am for a thirty-endpoint API |
| **Money is an integer in minor units**, not `numeric` as the ER diagram says | removes a class of rounding bug from a POC that does not need decimals |
| **The AppHosts are `aspire/AppHostA` and `aspire/AppHostB`**, not `control-plane` / `acme-vps` | the directory says what the docs say. The dedicated tenant is `zenith`, so nobody reads `acme` as "the dedicated one" |
| **Traefik is on 28080** | task 00 found `qbittorrent` holding 8080 and planned 8090; the port pass (`8c72b7e`) moved the edge to **28080** and gave it the `MERCATUS_EDGE_PORT` override, so a collision is an export rather than an edit. This row said "on 8080 after all" until the v2.0.0 handover, which was three ports out of date |
| **Foreign keys became composite `(id, tenant_id)`**, reversing task 02's "noted rather than built" | task 12 proved the single-column version was a live cross-tenant denial of service. `docs/OPEN-DEFECTS.md` F1 has the before/after transcript |

### Security and trust-boundary compromises

| Decision | Reason |
|---|---|
| **CORS is `origin: true, credentials: true` everywhere** | there is no real origin list on a laptop. It is also what hides **EW** |
| **The storefront holds `FAKE_BANK_HMAC_SECRET`, on the dedicated box too** | `POST /payments/proxy` was out of scope for the task that needed it, and every task after inherited the compromise. This is the one that would be embarrassing in front of a security reviewer |
| **The licence is Ed25519-signed, and the dev private key is committed** at `apps/platform/keys/dev-licence-private.pem` | asymmetric so a box whose owner has root can verify a licence and cannot mint one. The key is committed because a key that changes per boot would make a cached JWKS wrong after every restart; `loadPlatformConfig` refuses it under `NODE_ENV=production` |
| **Role passwords and the Postgres superuser password are literals in the repo** | `sql/00-roles.sql` and `apphost.cs`. Templating them needs a substitution step for a database that only ever exists on a laptop. Aspire's generated password was pinned because a random one is not URL-safe and every connection string here is a URL |
| **The pooled store polls the control plane with a shared `PLATFORM_INTERNAL_TOKEN`** | `CE1`'s per-instance credential is about a box whose owner has root. The pooled plane is our own process serving every tenant, so per-instance has nothing to name. A dedicated plane never sees this token |
| **The whole stub session lives in `localStorage`** in both SPAs | the stub issues no refresh token, so the documented in-memory-access-token split would sign the merchant out on every reload. Two files, named in the decisions doc, are what the Identity phase replaces |

### Behaviour you may want to argue with

| Decision | Reason |
|---|---|
| **Grace is earned by a success** (task 12) | an instance that has never once reached the control plane gets three poll intervals of boot allowance and then goes `read_only` — no grace window at all. The window exists to cover *our* outage for a box that was licensed and lost contact; before this, a box whose credential was refused polled, was refused every tick, wrote nothing, and sold for ever |
| **A passive tenant keeps every staff write**, not just reads | "the dashboard is fully usable" (`CG3`) is a half-truth if the merchant can read their catalogue and not fix it |
| **`declined` is not `cancelled`** | a declined payment leaves the order `placed`. The order exists; the money did not arrive |
| **The store settles a payment by fetching it from fake-bank** and believing nothing the caller sends — reference must name the order, amount must match | no bank secret in the store, no inbound path to a dedicated box (`CE2`, `CE4`) |
| **Shoppers are platform-wide identities with a store-issued session cookie** | the store does OIDC once and then checks its own cookie, so an outage only blocks a first-ever sign-in at that store. It is what keeps the flagship demo intact |
| **Demo timings are `LICENCE_POLL_SECONDS=5`, `LICENCE_GRACE_SECONDS=60`** | defaults are 10 s and 72 h. A grace window is only demonstrable if you can sit through it |
| **`MERCATUS_LEAK_SABOTAGE` is committed as a test affordance** | a leak suite that has never been seen to fail is not evidence, and the experiment has to be one command for the next person rather than re-derived |
| **The e2e suite starts nothing and is not a turbo task** | `aspire run` owns the topology; turbo would replay a cached green against a stack that is no longer up |
| **The outage in the suite is `SIGTERM` on the platform *process*, never `aspire stop`** | for exactly the reason in **EV**. The suite captures argv/cwd/environ from `/proc` first and relaunches from them, under a supervisor that kills the child when DCP goes away |
| **`@mercatus/contracts` cannot be imported by a browser app**, so all three front ends work around it differently | `contracts` → `core`'s barrel → Fastify. The console restates four schemas, the dashboard aliases `core` to a two-line shim, the storefront imports types only. The real fix is **FE** below and it is about four lines |

One operational note: **`aspire new` must always be run with `--suppress-agent-init`.** Without it,
it appends a `PostToolUse` hook to your global `~/.claude/settings.json` and installs scripts in
`~/.aspire/hooks`. Task 00 hit this and reverted both. If you ever see a `hooks` block referencing
`.aspire` in that file, something ran `aspire new` without the flag.

---

## 5. Lessons worth carrying

`lessons/` has fourteen files and they are the highest-value thing in the repo after the code.
The condensed version:

**Postgres and RLS**

- `nullif(current_setting('app.tenant_id', true), '')::uuid` — after any transaction that set the
  GUC, the session value is `''`, not NULL, for the rest of that connection's life. Without the
  `nullif` you get a cast error instead of zero rows, intermittently, under a pool.
- `select set_config('app.tenant_id', $1, true)`, never `SET LOCAL` — `SET` takes no bind
  parameters.
- **Referential integrity runs with row security OFF.** That is the whole of F1: a single-column
  FK crosses tenants whatever your policies say. Parent needs `unique (id, tenant_id)`, FK must be
  composite.
- A superuser bypasses RLS even with `force row level security`. The runtime role must be a plain
  `LOGIN NOBYPASSRLS` role.
- Drizzle wraps every driver error as `Failed query: …` and hangs the real `PostgresError` off
  `.cause`. An assertion that matches `/Failed query/` passes for a typo in your own fixture.

**The toolchain**

- pnpm 12 **fails the install fatally** over an unapproved build script. Edit `allowBuilds:` /
  `onlyBuiltDependencies:` by hand — `pnpm approve-builds` rewrites `pnpm-workspace.yaml` — and
  re-read that file after *every* failed install, because the failure already wrote a half-entry
  into it.
- TypeScript is pinned to **5.9.3**: `typescript-eslint` peers on `<6.1.0` and `latest` is 7.x.
- `turbo run test` passes a task only the environment variables its `env` list names. That is how
  46 tests skipped themselves while the run stayed green for eight tasks. `pnpm -r test` inherits
  everything, so the two commands were not testing the same thing.
- Vite and Next binaries live in **the app's own** `node_modules/.bin`, never the repo root.

**Aspire**

- `aspire run` without `--detach` blocks for ever. `aspire stop` from the AppHost's own directory
  takes its containers with it, but returns before they are gone — poll `docker ps`.
- **`aspire stop` destroys that AppHost's Postgres.** Every "and then it recovers" story has to
  account for it. See **EV**.
- `dotnet build apphost.cs` typechecks a single-file AppHost in ~2 s. Use it between edits; a
  compile error found by `aspire run` costs a full start cycle.
- Node endpoints need `isProxied: false` (DCP's proxy binds loopback only, so Traefik in a
  container cannot reach through it) and the services bind `HOST=0.0.0.0`.
- Traefik's own admin entrypoint is `:8080` and collides with yours; move it with
  `--entrypoints.traefik.address=:8099`.
- A second AppHost needs its own dashboard/OTLP/resource ports in `apphost.run.json`, and the
  `http` profile must be first or the OTLP gRPC exporter meets a self-signed cert.
- OpenTelemetry must be a `--import` preload, before the app's module graph evaluates. Imported
  from `index.ts` it silently instruments nothing.
- `tr '\0' '\n' < /proc/<pid>/environ` is how you get an Aspire-managed process's environment,
  including the random Postgres host port, when you need to relaunch it by hand.

**Front ends**

- `next dev` renders fine and **never hydrates** if the origin is not in `allowedDevOrigins` —
  and it says so only in the dev server's own log. Nothing on the page, nothing in the console.
- Neither Turbopack nor webpack maps the workspace's `.js` relative imports back to `.ts`, so a
  runtime import of `@mercatus/contracts` from Next resolves to a module with no exports at all.
- Two `next dev` on one package directory need a `NEXT_DIST_DIR` each.
- `@fastify/cors@11` defaults to `GET,HEAD,POST`, so every browser PATCH and DELETE dies at the
  preflight with no error anywhere. Already fixed in `packages/core`; do not re-debug it.
- Playwright: use `channel: 'chrome'` (nothing to download), put `page.goto` **inside**
  `expect(...).toPass()`, and assert on an effect the DOM cannot fake — a cookie, a counter — never
  on the click landing.

**Shell traps that cost real time**

- `pkill -f "tsx src/index.ts"` kills your own shell, because the pattern matches the command line
  containing it. Kill by port instead.
- `path=` is tied to `PATH` in zsh. A loop variable called `path` gives you `command not found:
  curl`.
- `cmd | tee out.txt | head` kills the script via SIGPIPE. Redirect to a file and `sed -n` it.
- `vitest run | tail` reports **tail's** exit code, so the red half of a gate looks green.
- The bash tool kills a foreground command at 120 s: background anything longer and poll.

---

## 6. What I would do next

In priority order. The first two are what turn the POC from "works if you know the tricks" into
"works".

**FB. Make a running B recover by itself.** `apps/store/src/provision.ts` already verifies its
credential and re-registers on 401/403/404 — it just only runs at start. Give the licence poll
agent the same branch: on a 401/403/404 from `/tenants/:slug/licence`, re-run the registration
with the bootstrap token and carry on. Then the README's original demo script becomes true, and
"bring A back" is the whole recovery. Maybe an hour, mostly tests. This is **EV** closed.

**FC. Put the whole demo behind the edge.** Point `FAKE_BANK_URL`, `VITE_STORE_API_URL` and
`VITE_PLATFORM_URL` at `bank.`, `api.` and `platform.localtest.me:28080` in
`aspire/AppHostA/apphost.cs`, then tighten `packages/core`'s CORS from `origin: true` to that
origin list. The two changes belong together: the second is only possible once the first is done,
and the first is only *checkable* once the second is. That closes **EW** and **EX**, and it makes
the README's one-port claim true rather than nearly true.

**FD. Show the shopper on the merchant's order detail.** The data is already in the store and
already RLS-protected; this is a join and a `<dl>`. Closes **EY**, and it is the first thing a
person looking at the dashboard asks for.

**FE. Move `DEFAULT_PAGE_LIMIT` and `MAX_PAGE_LIMIT` out of `@mercatus/core`'s barrel** — into
`@mercatus/contracts`, or behind a `./constants` export. Four lines, and it deletes three separate
workarounds (the console's restated schemas, the dashboard's browser shim, the storefront's
type-only import). Three agents were in the tree at once and nobody wanted to be the one editing a
shared package; nobody is in the tree now.

**FF. One command for the headline check.** A `scripts/demo.sh` that starts both AppHosts, waits
for the eight URLs, runs `pnpm test:e2e`, and stops both — so "does the demo still work" is one
line and not a paragraph of instructions. Closes the practical half of **EZ**.

**FG. Build `POST /payments/proxy` and take `FAKE_BANK_HMAC_SECRET` off the dedicated box.** The
control plane already has the signing code and the callback verifier; the store needs a route and
the storefront needs to call the store instead of the bank. This is the last structural
`CE2` violation, and it is the one a reviewer would find first.

**FH. Then, in whatever order you like:** RLS on the control plane (`F4`) if the platform API will
ever serve merchants; `F5` and `F6`; automated coverage of the OIDC path, which needs the browser
suite to stop depending on `/dev/login/*`; and tier 2, which is a `domains` table and DNS rather
than new architecture — `resolveTenantCandidate` was written to make that an addition rather than
a retrofit.

What I would **not** do: add CI, add a job queue, add a component library, or generate an API
client. All four were considered and declined for reasons that are still good, and they are in
`docs/decisions-made-overnight.md` with the reasoning.
