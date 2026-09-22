# 10 — AppHost B, the dedicated instance, and the flagship demo

Status: **done**. Both AppHosts ran together, `zenith` registered itself, bought something, and
kept selling after `aspire stop` took the entire control plane down. The full transcript is below.

## What exists now

### `aspire/AppHostB/apphost.cs` — "Zenith's VPS" (new)

A second Aspire application. What it contains: `pg-zenith`, `migrate-zenith`, `provision-zenith`,
`store-zenith` (4003, `DEPLOYMENT_MODE=dedicated`), `storefront-zenith` (3002) and
`dashboard-zenith` (5175). What it does **not** contain is the point: no `db-platform`, no
`db-logto`, no platform process, no fake-bank. It cannot reference AppHost A's databases because
they are not in its model — `CO3` stops being a convention a reviewer has to remember (`EP`).

Its only edges to the control plane are three `AddExternalService` entries, all HTTP:

| | |
|---|---|
| `control-plane` | `http://platform.localtest.me:8080` — A's Traefik, a fixed port |
| `fake-bank` | `http://bank.localtest.me:8080` — the CE2 compromise, in the open |
| `identity` | `http://127.0.0.1:3011` — Logto's own host port; A's edge has no router for it |

None of them is a `WaitFor`. A dedicated instance must boot with the control plane unreachable.

`apphost.run.json` moves B's dashboard to **15240**, OTLP to **19081** and the resource service to
**20015** (BUILD-PLAN §8.1), or the two AppHosts fight over A's. `aspire.config.json` names
`apphost.cs`, which is what lets `aspire run` in either directory know which application is meant;
`--apphost aspire/AppHostB` says it explicitly from anywhere else.

### `apps/store/src/provision.ts` — the install command (new)

`pnpm --filter @mercatus/store provision`. What an operator runs on their own server once, and
what B runs as `provision-zenith`:

1. `POST {platform}/installations/register` with the one-time bootstrap token
2. writes `{installationId, instanceToken, tenantId, tenantSlug, registeredAt}` to
   `INSTANCE_TOKEN_PATH`, mode **0600**
3. mirrors the tenant the control plane named into **this box's** database (`BV1` — the id is
   theirs, never invented here) and ensures its order counter
4. `DEV_SEED_CATALOG=1` only: four products and a branding row, so the shop has something to sell

Idempotent (`CK2`): with the credential file present it skips straight to the mirror, because a
bootstrap token can only ever be spent once and a re-run must not brick a box.

### `apps/store/src/instance.ts` — reading that credential at boot (new)

`withInstanceCredential(loadStoreConfig())` in `index.ts`. An explicit `INSTANCE_TOKEN` wins; a
credential naming another tenant is a boot failure; a **missing** file is not fatal — the licence
agent logs that it has no control plane and the store serves, because "never polled" is healthy
and a shop that will not start because our registration endpoint was down is the exact failure
`CG1` exists to prevent.

### The storefront degrades instead of erroring

`POST /api/checkout` used to answer **502 CONFLICT** when fake-bank could not be reached. It now
answers **202** with the order, records the payment as `unreachable`, and the client lands on the
confirmation page, which says *"Placed, not yet paid. The payment service could not be reached, so
nothing was charged. Your order stands and the shop kept selling."* The order was always real —
this is the difference between a demo that says so and one that shows a red error.

### Environment (§8.2)

Two new variables: `INSTANCE_TOKEN_PATH` (the store) and `INSTANCE_BOOTSTRAP_TOKEN` (the install
command only — a server never sees it). `TENANT_NAME` and `DEV_SEED_CATALOG` belong to the install
command alone.

## The gate, observed

`aspire run --detach` in `aspire/AppHostA`, then in `aspire/AppHostB`. A was healthy 25 s after
the command; B 20 s after its own.

**Registration, unattended:**

```
.instance/zenith.json   -rw------- 255 bytes
  installationId 3f6b0b8a-...-0a1b2c3d4e20   tenantSlug zenith   registeredAt 06:57:42Z

GET /installations (operator, on the control plane):
  {"tenantSlug":"zenith","version":"1.0.0","licenceId":"1c9db979-...",
   "productCount":4,"orderCount":0,"lastSeenAt":"06:58:08Z"}

GET /api/licence (staff, on THEIR box):
  {"status":"active","state":"healthy","lastSuccessAt":"06:58:08Z"}
```

The heartbeat is the only thing the control plane knows about that box (`CE4`, `CL1`), and it
carries version, tenant, licence id and two counts (`CE6`, `CI1`).

**A purchase on the dedicated storefront, control plane up:**

```
POST 127.0.0.1:3002/api/checkout  -> 200
  {"orderId":"ab210c7f…","number":1,"totalMinor":749900,"currency":"TRY",
   "paymentUrl":"http://bank.localtest.me:8080/pay/ae35e5ac…"}
POST bank/pay/ae35e5ac…/complete {"behaviour":"approve"}
  -> status paid, callback delivered:true httpStatus:204 signatureCorrupted:false
GET  127.0.0.1:3002/api/payments/ab210c7f…  -> {"outcome":"paid","source":"callback"}
```

Zenith's first order is **1** — its own counter, not the pooled sequence (`BG2`). Stock went 4→3.
The next heartbeat reported `orderCount: 1`.

**`aspire stop` on AppHost A — the whole plane, not a resource.** One line a second, on the
dedicated box:

```
06:59:15  >>> aspire stop, AppHost A
06:59:15  storefront=200  api=200  licence=active/healthy     shopper-sees=open
06:59:28  >>> CHECKOUT during the outage (already-signed-in shopper):
          {"orderId":"c668a074…","number":2,"totalMinor":99900,
           "paymentUrl":null,"payment":"unreachable"}  HTTP=202
06:59:29  storefront=200  api=200  licence=active/grace       shopper-sees=open
07:00:13  storefront=200  api=200  licence=active/grace       shopper-sees=open
07:00:14  storefront=200  api=200  licence=active/read_only   shopper-sees=blocked_unreachable
07:01:07  >>> CHECKOUT past the grace window:
          {"error":{"code":"CONTROL_PLANE_UNREACHABLE","message":"Temporarily unable to take orders."}}  HTTP=503
07:01:24  storefront=200  api=200  licence=active/read_only   shopper-sees=blocked_unreachable
```

Thirteen seconds after the control plane died, a shopper completed a checkout. **45 seconds of
grace** in which nothing was refused, then read-only — and `storefront=200 api=200` on every one
of the 115 samples. The licence **status stayed `active` throughout**: being unreachable never
becomes being passive (`CG3`).

Still during the outage, and still on their box:

```
GET /t/zenith/orders (shopper cookie)  -> total 2: order 2 placed, order 1 placed
GET /api/orders      (staff)           -> 200
POST /api/products   (staff)           -> 503   (read_only refuses writes, not reads)
GET  127.0.0.1:5175  (their dashboard) -> 200
```

**Bringing A back.** The control plane returned at 07:02:50 and `zenith` stayed `read_only` —
because `aspire stop` had destroyed A's Postgres, the rebuilt control plane had never heard of
this installation, and the instance token it holds answered **401**. That is correct behaviour and
worth knowing before a demo: the store did not crash, did not resume, and kept serving. Re-running
the install command (the re-seeded bootstrap token is unspent again) and restarting the store
process gave the real recovery:

```
07:04:09  zenith-licence=active/healthy        (one poll after the restart)
POST /api/checkout -> 200  {"number":3, "paymentUrl":"http://bank.localtest.me:8080/pay/97c4d466…"}
GET  /installations -> {"orderCount":3, "licenceId":"12f419f0…", "lastSeenAt":"07:04:15Z"}
```

Orders **1, 2 and 3** — the two placed while we were dark survived, the numbering stayed gapless,
and the control plane learnt the count it had missed from the next heartbeat.

**Repo check:** `pnpm turbo run typecheck lint test` → **31/31 tasks, exit 0**. The two
database-backed store suites skip without a `DATABASE_URL`, so they were also run explicitly
against a Postgres: `pnpm --filter @mercatus/store test` → **33/33**.

## What the next agent needs to know

1. **A true recovery demo must not use `aspire stop` on A.** It takes A's Postgres with it, so the
   rebuilt control plane no longer knows the instance token B holds and B stays `read_only` (401).
   For "it catches up when we come back", kill the **platform process** instead
   (`kill -TERM <pid>`; DCP does not restart it) as task 09 did. `aspire stop` on A is the right
   demo for "the whole plane is gone", which is what task 10 was asked for.
2. **The store reads its credential file once, at boot.** Re-registering means restarting the
   store process. `tr '\0' '\n' < /proc/<pid>/environ` is the cheapest way to get an
   Aspire-managed process's environment back so you can relaunch it by hand.
3. **`.instance/` is gitignored.** Deleting `.instance/zenith.json` is how you make B register
   again; the dev bootstrap token is re-seeded unspent whenever A's database is rebuilt.
4. **AppHost A still does not run the pooled storefront, dashboard or console** (07a–07c left
   them out). B runs its own two. If task 11 or 12 wires A's, copy B's `Node(...)` helper —
   `node node_modules/next/dist/bin/next dev` and `node node_modules/vite/bin/vite.js`, with the
   port arriving as `PORT` from `WithHttpEndpoint(env: "PORT")`.
5. Untouched from 09: `apps/platform/src/schemas.ts` has not moved into `packages/contracts`, and
   `packages/contracts/src/common.ts` still imports from `@mercatus/core`, so the dashboard's
   `src/vendor/core-browser.ts` shim is still load-bearing. `docs/OPEN-DEFECTS.md` F1 is still
   open.

## Machine state

Left as found. `aspire stop` run on both AppHosts; the hand-restarted `store-zenith` process was
killed. `.instance/zenith.json` was **deleted**: it held a credential for a control-plane database
that no longer exists, so leaving it would make the next `aspire run` of B skip registration and
poll with a token the platform has never seen. With it gone, B provisions itself cleanly again. `docker ps` shows only `mercatus-dash-gate-pg` (task 07b's leftover on 55432, reused here
for the store test run) and `chess-trainer`, both pre-existing. Ports 3001, 3002, 4001–4004, 5173,
5174, 5175, 8080, 15230 and 15240 are free.
