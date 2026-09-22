# 09 — the licence gate, the poll loop, and driving the demo

## Fastify

- **A per-route flag is `config`, and the hook reads it as `req.routeOptions.config.<key>`.**
  Augment `FastifyContextConfig`, not `FastifyRequest`:

  ```ts
  declare module 'fastify' { interface FastifyContextConfig { licence?: 'checkout' | 'write' } }
  ```

  It is typed, it shows up in the route definition, and a global `preHandler` can return in one
  line for every route that did not opt in.
- The hook must be **`preHandler`, not `onRequest`**: `req.tenantContext` is set by the auth hook,
  and an `onRequest` gate sees `undefined` and silently gates nothing.
- Register the gate **before** the routes. A hook added after `app.post(...)` in the same scope
  does not apply to it.
- A status a route's `response` map does not list still serialises fine through the error handler;
  adding `503: errorEnvelopeSchema` only changes the OpenAPI document.

## The state machine

- **Dropping the `mode === 'pooled'` shortcut is safe only because "never polled" is healthy.**
  `runtimeState` keys on `last_success_at === null`, so an instance with no `PLATFORM_URL` never
  enters grace. Without that, removing the mode branch puts every store with no control plane into
  a permanent outage.
- `recordLicenceAttempt` is an `UPDATE` with no `WHERE` (RLS finds the row). With no row yet it is
  a silent no-op, which is correct and worth knowing when a first poll fails.
- Backdating `last_success_at` in a test: `recordLicenceSuccess` stamps `now()`, so the age has to
  be set afterwards with raw `sql`. Threading a clock through the repository for one test is worse.

## The poll agent

- `AbortSignal.timeout(ms)` on `fetch` is the whole timeout story in Node 22 — no controller, no
  `clearTimeout`.
- `setInterval(...).unref()` plus a `running` flag: skip a tick rather than overlap it, or a slow
  control plane turns the agent into a queue of pending fetches that all land at once.
- Log a failed poll at **warn, not error**. Being unreachable is a designed state; an error a
  second during an outage buries the one line that matters (the transition to `read_only`).
- Parse the control plane's answer with the Zod schema. It is a separately released deployable
  (CH1); a shape you do not recognise should be a failed poll, not an `undefined` reaching the gate.

## Credentials

- `timingSafeEqual` throws on differing lengths — compare lengths first, then call it.
- Order the checks in the guard so the **cheap local compare runs before** the JWT verify and the
  database lookup. The pooled plane hits that route once per tenant every 5 seconds.

## Running the demo

- **The dev-seed's `tenants` table is the poll list.** The pooled agent enumerates it, so a tenant
  added after boot is picked up on the next tick with nothing restarted.
- Killing the Aspire-managed `platform` process with `kill -TERM` works and **DCP does not restart
  it**. That is the cheapest way to produce "control plane unreachable" — no firewall, no compose
  edit. `aspire stop` afterwards still cleans up everything.
- To bring it back by hand you need its environment, and the Postgres host port is random:
  `docker ps | grep pg-platform` gives it, then run
  `node --import tsx src/index.ts` from `apps/platform` with `DATABASE_URL`, `AUTH_STUB_SECRET`,
  `PLATFORM_INTERNAL_TOKEN`, `FAKE_BANK_*`. It rejoins the topology fine.
- **Vite is at `apps/<app>/node_modules/.bin/vite`, NOT at the repo root** (pnpm, no hoisting).
  `../../node_modules/.bin/vite` → `No such file or directory`.
- The storefront needs `FAKE_BANK_HMAC_SECRET`, `STORE_API_URL` and `FAKE_BANK_URL` in its
  environment or every page is a 500 — its config parses lazily, per request, so `next dev`
  reports "Ready" first and fails at the first fetch.
- Backgrounding a long-lived dev server with `(nohup … &)` inside a subshell whose parent exits
  kills it. Use the harness's own background execution instead.

## Driving Chrome (confirming 07c)

- Clicking by **coordinate from a fresh screenshot** works; the coordinates are always in the
  full-resolution frame the screenshot header reports, not the scaled image's own pixels —
  `x_full = x_shown * frame_w / shown_w`.
- Verify a click by its **effect** (the next poll's answer on the wire), never by the screenshot.

## Measuring it

- One `bash` loop writing one line a second, with a column per surface, is a better artifact than
  any amount of prose: the whole claim is that the columns DISAGREE, and a table shows that at a
  glance. `date -u +%H:%M:%S` before the click, then diff the timestamps.
- Beware: a loop that checks out one item a second **exhausts the seeded stock** and starts
  answering 409, which looks like a licence refusal if you are not reading the code. Restock, or
  read the numbers.
