# Morning

Thirteen tasks ran overnight. The build is up, the demo works, and there is one place where the
README told you a lie — it is fixed, and what it was is written down below rather than quietly
corrected.

Everything in **What works** was re-verified this morning, on this machine, between 11:49 and
11:59. Nothing here is inherited from an agent's own report.

Read this file, then `docs/decisions-made-overnight.md` if you want the full list of judgement
calls, then `lessons/` if you are about to write code.

---

## 1. Run it

```bash
cd ~/Desktop/projects/mercatus
pnpm install                       # ~3s warm

# A -- control plane, identity, fake-bank, the pooled store, storefront,
#      dashboard, console, and the edge on 8080
( cd aspire/AppHostA && aspire run --detach --non-interactive --nologo --format Json )

# B -- "Zenith's VPS": its own Postgres, the same store, DEPLOYMENT_MODE=dedicated
( cd aspire/AppHostB && aspire run --detach --non-interactive --nologo --format Json )
```

A is ready in ~15 s, B in ~15 s more. `--detach` is not optional: without it the command never
returns. Readiness, in one loop:

A's surfaces all come through the edge, so they are the one set of addresses still worth typing.
B's two are Aspire-assigned, so they are read out of the address book the run wrote:

```bash
E=${MERCATUS_EDGE_PORT:-28080}
for u in http://platform.localtest.me:$E/health \
         http://api.localtest.me:$E/health \
         http://bank.localtest.me:$E/health \
         http://shop.localtest.me:$E/t/acme \
         http://dash.localtest.me:$E/ \
         http://console.localtest.me:$E/ \
         "$(jq -r .endpoints.store .stack/apphost-zenith.json)/health" \
         "$(jq -r .endpoints.storefront .stack/apphost-zenith.json)/t/zenith"; do
  printf '%s -> %s\n' "$u" "$(curl -s -o /dev/null -m 4 -w '%{http_code}' "$u")"
done
```

All eight answer 200. And back down, each from its own directory — B first if you want B's
credential to stay valid:

```bash
( cd aspire/AppHostB && aspire stop --non-interactive --nologo )
( cd aspire/AppHostA && aspire stop --non-interactive --nologo )
docker ps            # should show only chess-trainer, which is not ours
```

### The demo, step by step

1. **Shop.** `http://shop.localtest.me:8080/t/acme` → sign in at `/signin` with any `+90…`
   phone → add to basket → check out. You are handed fake-bank's hosted page (it opens on
   `127.0.0.1:4004` — see **EW**), click **approve**, then browser **Back**: the checkout page's
   `pageshow` handler takes you to the confirmation, which says `paid`.
2. **Buy from the second shop** at `/t/borg` without signing in again. Same account, one order at
   each store — that is `Q20` and `BI2` working.
3. **Merchant.** `http://dash.localtest.me:8080` → sign in as slug `acme`, role `owner`. The order
   is there with a Payment column. `borg`'s orders are not, and cannot be reached.
4. **Operator.** `http://console.localtest.me:8080` → sign in → flip `acme` to **passive**. Within
   one poll (5 s) the storefront refuses checkout and keeps browsing open; the dashboard stays
   fully usable. Flip it back.
5. **The flagship.** Buy something on the dedicated store, `http://127.0.0.1:3002` (Zenith, "their
   server", its own database, AppHost B). Then kill our whole control plane:

   ```bash
   ( cd aspire/AppHostA && aspire stop --non-interactive --nologo )
   ```

   Buy again. The order is placed, numbered and priced; only the payment waits (202 — payments are
   ours and never run on a customer's server, `CE2`). Browsing stays 200 throughout. After
   `LICENCE_GRACE_SECONDS` — 60 s here, 72 h by default — checkout degrades to **503
   `CONTROL_PLANE_UNREACHABLE`** and the dashboard goes read-only.

   **To recover you must restart B as well as A.** This is the correction; **EV** explains why.

   ```bash
   ( cd aspire/AppHostA && aspire run --detach --non-interactive --nologo --format Json )
   ( cd aspire/AppHostB && aspire stop --non-interactive --nologo )
   ( cd aspire/AppHostB && aspire run --detach --non-interactive --nologo --format Json )
   ```

   B re-registers on start, `GET /installations` goes back to `total: 1`, and the store is
   `active/healthy` with `checkout: open` on the next poll.

### The three checks

```bash
pnpm -r test                    # 244 tests, 0 skipped, ~35s. No stack needed.
pnpm turbo run typecheck lint   # 26/26
pnpm test:e2e                   # 16 Playwright tests in real Chrome, ~40s. Needs both AppHosts up.
```

Plus two single-purpose gates worth knowing about:

```bash
MERCATUS_LEAK_SABOTAGE=products pnpm --filter @mercatus/db-store test   # must go RED
packages/identity/scripts/login-round-trip.sh                          # a real OIDC code flow
```

---

## 2. What works — verified this morning

| | Evidence |
|---|---|
| `pnpm -r test` | **244 passed, 0 skipped**, exit 0. core 26, contracts 25, db-platform 11, fake-bank 17, platform 22, db-store 98, store 45 |
| `pnpm turbo run typecheck lint` | 26 tasks, 26 successful |
| `pnpm test:e2e` | **16 passed in 40.6 s**, real Chrome, headless, against both AppHosts live. The relaunched control plane it leaves behind died with the AppHost, as its supervisor promises |
| AppHost A | up in ~15 s; all six edge hostnames and all seven direct ports 200; Logto `/api/status` 204 |
| AppHost B | up in ~15 s, **re-registered by itself** from a credential file naming a database that had been destroyed the night before |
| Tenant isolation | 98 db-store tests, including the F1 composite-FK attack cases, against a real Postgres per run |
| Degradation | reproduced end to end this morning, with timings, in **EV** |
| Cleanup | after `aspire stop` on both, `docker ps` shows only `chess-trainer` and none of our ports are held |

The five headline claims from the README, honestly graded:

1. **Tenant isolation that isn't a `WHERE` clause** — yes. RLS, forced, tenant from the token, a
   suite that has been *seen to fail* under `MERCATUS_LEAK_SABOTAGE`, and a grep test that fails
   the build if application code writes `where tenant_id`.
2. **One image, two deployment modes** — yes. The same `apps/store` source runs pooled on A and
   dedicated on B, one environment variable apart.
3. **Centralised identity** — real, but **only exercised by a shell script**
   (`packages/identity/scripts/login-round-trip.sh`). The browser suite drives the stub adapter.
   See **EZ**.
4. **Graceful degradation** — yes, and it is the best thing in the build. Caveat in **EV**.
5. **Failure injection for payments** — yes. `approve` / `decline` / `bad-hash` / `no-callback` /
   `drop`, chosen from a query parameter or the hosted page.

---

## 3. What does not work

No optimism in this section. Six things, worst first.

**EV.** **The demo's last beat needed a correction, and the README now carries it.** The README
said: stop A, buy again, wait out the grace window, "bring A back and it returns to
`active/healthy` within one poll." That is false, and I reproduced it this morning.
`aspire stop` on A destroys A's Postgres, so a rebuilt control plane has never heard of the
installation: `GET /installations` answers `{"items":[],"total":0}` and B's stored token gets a
**404**. A *still-running* B keeps polling — `lastCheckedAt` advanced to 11:54:25 — but
`lastSuccessAt` stayed frozen at 11:52:25, so the dedicated store sat at `state: read_only` and
`checkout: blocked_unreachable` indefinitely. Re-registration only happens at B's **start**
(`apps/store/src/provision.ts`), so bringing A back never recovers a running B. Restarting B fixed
it in one poll: `total: 1`, `healthy`, `checkout: open`. The README's demo script now says so. The
real fix is one small change, and it is **FB** below.

**EW.** **"Everything of A's answers on one port" is true of HTML documents and of nothing else.**
Two leaks off the edge, both verified live:

- A checkout driven entirely through `shop.localtest.me:8080` answered
  `"paymentUrl": "http://127.0.0.1:4004/pay/…"`. fake-bank builds that URL from the request it
  received (`apps/fake-bank/src/routes/payments.ts:70`) and the storefront calls it at
  `FAKE_BANK_URL=http://127.0.0.1:4004`. The `bank.localtest.me:8080` route exists and the flow
  never uses it.
- The dashboard and console SPAs are *served* through the edge and then call the APIs direct:
  `VITE_STORE_API_URL=http://127.0.0.1:4002`, `VITE_PLATFORM_URL=http://127.0.0.1:4001`, both set
  in `aspire/AppHostA/apphost.cs`.

On a laptop it is invisible. Expose or firewall only `:8080` and checkout plus every dashboard XHR
breaks. The README's edge table now says which parts go through the edge.

**EX.** **CORS is wide open on every API.** `origin: true` with `credentials: true` in
`packages/core/src/http/server.ts:76`. Any origin is reflected and allowed to send credentials.
The comment calls it a POC compromise, which it is — and it is also exactly what keeps **EW**
invisible, because nothing ever complains about the cross-origin call.

**EY.** **The merchant cannot see who bought.** The order detail at
`dash.localtest.me:8080/orders/<id>` renders the number, the status, the payment reference, the
date, the lines and the total — and no shopper name, phone or identifier anywhere. The store holds
the shopper (the storefront signs them in by phone; `shoppers` is an RLS table with leak-suite
cases of its own), so this is a gap in the dashboard, not in the data. "Which of my customers
placed this order" is currently unanswerable in the merchant UI.

**EZ.** **A green `pnpm -r test` does not include the browser demo.** `packages/e2e` declares
`test:e2e` and no `test` script, so the recursive run covers **13 of 14** workspace projects and
stops at unit/integration level. The storefront, the dashboard, the console, the edge and the
outage scenario are exercised only by `pnpm test:e2e`, by hand, against a live stack. It fails
loudly rather than silently — global setup refuses and names the missing `aspire run` — but the
headline command everyone runs is not the headline check. The OIDC path has no automated coverage
at all; `login-round-trip.sh` is a shell gate somebody has to remember to run.

**FA.** **Known and still open, in descending order of how much they should bother you.**

| | |
|---|---|
| `CE2` violation | the storefront signs fake-bank requests itself with a shared `FAKE_BANK_HMAC_SECRET`, **including on the dedicated box**, because `POST /payments/proxy` was never built. A merchant with root on their own server holds a key that can sign payment requests |
| `F4` | the control plane has **no RLS at all** — six tables, four carrying `tenant_id`, full CRUD for the app role. Fine while the only consumer is the operator console; the next leak comes from here the day the platform API serves a merchant-facing view |
| `F5` | inserting a product with another tenant's known product UUID fails with `duplicate key`, not an RLS error — an existence oracle against a UUID you already hold |
| `F6` | a non-UUID `app.tenant_id` raises `invalid input syntax for type uuid` at query time rather than at `set_config` time. Fails closed, surfaces far from the cause |
| not built | tier 2 (custom domains), `POST /payments/proxy`, any payments screen in the console, a screen for issuing bootstrap tokens, `PATCH /api/settings` (this one deliberately — `tenants` has no RLS policy, so the app role is SELECT-only and the edit belongs on the platform API) |
| git | the repo is **3 commits ahead of `origin/develop` and unpushed** — the standing instruction to every agent was "NEVER push", and there is a real remote (`git@github.com:erkantaylan/mercatus.git`). Your call, not ours |

Two small things found while checking: `diary/12-repair-pass.md` and `lessons/12-repair-pass.md`
both give the suite total as 235, but their own per-package breakdown adds to 244, which is what
the suite reports. And `.instance/zenith.json` always names an installation in whatever platform
database existed when B last started — that is now harmless (B checks and re-registers), and it is
deliberately left in place because leaving it is what proves the fix on the next run.

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
| **Traefik is on 8080 after all** | task 00 found `qbittorrent` holding it and planned 8090; it was free every night since. If a run ever dies with `bind: address already in use`, that is one line in `apphost.cs` |
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
`VITE_PLATFORM_URL` at `bank.`, `api.` and `platform.localtest.me:8080` in
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
