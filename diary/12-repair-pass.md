# 12.1 — repair pass

Task: fix the eleven findings from the failed acceptance check, worst first. Nothing was disabled;
everything named below is fixed and verified against a running stack, not only in a test.

## What changed

### CRITICAL — F1, the cross-tenant denial of service (`docs/OPEN-DEFECTS.md`)

`packages/db-store/src/schema.ts` carried single-column foreign keys, so tenant B could insert an
`order_lines` row carrying **its own** `tenant_id` (which `with check` accepts) while pointing at
tenant A's order and product. A then could never delete that order or product again, could not see
the planted row, and had no way to remove it. Referential integrity runs with row security OFF.

- `unique (id, tenant_id)` on `orders`, `products`, `shoppers`; all three FKs composite with
  `tenant_id`.
- Migrations **regenerated as one file** (`0000_data_plane.sql`). drizzle-kit emitted the new
  unique constraints *after* the FKs referencing them, which Postgres refuses; databases here are
  built fresh per run, so a squash beats hand-ordering generated SQL (J1).
- `packages/db-store/test/leak.test.ts` grew a `referential integrity is tenant-consistent (F1)`
  section: a structural case asserting every FK in the live database carries `tenant_id`, the
  three attack inserts (each now 23503), and the victim's half — borg deleting its own order and
  product afterwards.
- **F2**: `grant select on table tenants` is gone. Three `SECURITY DEFINER` functions
  (`mercatus_tenant_by_slug`, `..._by_id`, `..._directory`) are the only way in; the directory
  returns id and slug only, for the pooled poll list. `repositories/tenants.ts` and the licence
  agent read through them.
- **F3**: `revoke connect on database %I from public` added to `db-store/sql/00-roles.sql`,
  asserted from the leak suite against `pg_database.datacl`.

### CRITICAL — the licence gate failed open

`runtimeState()` returned `healthy` whenever `lastSuccessAt` was falsy, and `recordLicenceAttempt`
was an `UPDATE` with no row to update — so an instance whose credential the control plane rejects
polled, was refused on every tick, wrote nothing, and sold for ever.

- New column `licence_state.polling_since`: first poll attempt ever, never cleared.
- `recordLicenceAttempt` is an upsert and takes the tenant id.
- **Grace is earned by a success**: never-succeeded → three poll intervals of boot allowance, then
  `read_only`. No grace window, however long the window is configured to be.
- `pollingSince` is on the `LicenceView` contract, so an operator can tell "never configured to
  poll" (null) from "polling and always refused".

### CRITICAL — the demo was broken on every run after the first

`aspire stop` on AppHost A destroys A's Postgres, so the installation record is gone, but
`.instance/zenith.json` survives — and `provision.ts` skipped registration whenever that file
existed. `apps/store/src/provision.ts` now **verifies** the credential against
`GET /tenants/:slug/licence` and re-registers on 401/403/404. Unreachable is not a refusal: it
keeps the credential and boots (CG1). No `rm .instance/zenith.json` is needed any more, and the
README no longer claims B never needs the bootstrap token again.

### HIGH — 46 tests that never ran

`apps/platform` (22 skipped) and `apps/store` (24 skipped) owned no database and skipped
themselves. Both now own a container through new `@mercatus/db-platform/testing` and
`@mercatus/db-store/testing` exports (the db-store global setup was refactored into
`test/harness.ts` and reused). `turbo.json`'s `test` env list is down to `MERCATUS_LEAK_SABOTAGE`.

### HIGH — nothing but the API and the bank was reachable through the edge

`aspire/AppHostA/traefik/dynamic.yml` now routes `shop.` (storefront), `dash.` (dashboard),
`console.` (platform console) and `api.` alongside `platform.` and `bank.`, keeping the catch-all
to the store API so host-based tenant resolution still works. Both Vite dev servers bind `0.0.0.0`
and accept `.localtest.me` hosts; the storefront's `allowedDevOrigins` gained the hostname.
README's tier-1 address is now the one that exists.

### HIGH — the e2e suite was single-shot

`01-pooled-two-tenants` and `03-dedicated-outage` aborted unless the tenants had zero orders.
Both now take a baseline in `beforeAll` and assert `before + 1`, mint their own shopper per run
(`freshShopper()`), and close the browser context with `?.` so a failed `beforeAll` is not buried
under a TypeError.

### MEDIUM — the orphaned control plane

`03-dedicated-outage` relaunches the platform it killed; that process is not Aspire-managed, so
`aspire stop` left it holding 4001 and answering `/health` 200 over a destroyed database. It is
now started under `packages/e2e/tests/helpers/supervised-relaunch.mjs`, which watches DCP's pid and
terminates the child when the AppHost stops. The watch target is inherited on a re-run, or the
second run kills its own relaunch (it did, once).

### MEDIUM — a paid order looked exactly like an abandoned one

Settlement lived only in the storefront process's memory. Now:

- `orders` carries `payment_status` / `payment_ref` / `paid_at`; `paid` also moves
  `orders.status`.
- `POST /t/:slug/orders/:id/payment` (`apps/store/src/routes/payments.ts`) takes a payment id and
  **nothing it believes**: the store fetches the payment from fake-bank and accepts it only if its
  `reference` names that order and the amount matches. No bank HMAC secret is added to the store
  (CE2) and no inbound path is created (CE4).
- The storefront forwards every settled outcome (verified callback, and a bank-learnt one).
- The dashboard shows a Payment column and the order detail says so.
- `apps/store/test/settlement.test.ts` — 9 cases against a real stub bank on an ephemeral port.

### LOW

- `mercatus-dash-gate-pg` (task 07b's hand-started gate database, on `0.0.0.0:55432` since 05:33)
  removed.
- README: the "start those by hand" paragraph is gone — AppHost A starts all of it; the edge table
  is new; the tier table is corrected.
- README states plainly that the OIDC path is exercised by
  `packages/identity/scripts/login-round-trip.sh`, not by the e2e suite.

## The gate

- `pnpm -r test` — **235 passed, 0 skipped** (was 189 passed / 46 skipped). `pnpm turbo run lint
  typecheck` — 26/26.
- Every surface through the edge on 8080: `shop.`, `dash.`, `console.`, `platform.`, `bank.`,
  `api.localtest.me` and `127.0.0.1:8080/health` all 200; the storefront through the edge renders
  acme's catalogue.
- Licence fail-closed, live, on AppHost B with the control plane down and no prior success:
  `healthy` for 15s, then `read_only`, `checkout: blocked_unreachable`, `POST /checkout` → 503
  `CONTROL_PLANE_UNREACHABLE`, browsing 200 throughout. `lastCheckedAt` advances on every failed
  poll (it used to stay null).
- Re-registration, live: A rebuilt, B restarted → `REFUSED the credential ... Re-registering.` →
  `/installations` `total: 1`, heartbeat arriving, `checkout: open`.
- `pnpm test:e2e` **run twice back to back against the same stack**, no rebuild: 16 passed, 16
  passed.

## State left behind

- Both AppHosts are stopped, all their containers are gone, all the ports are free. The only
  container running is `chess-trainer`, which is not ours and was here before.
- `.instance/zenith.json` holds a credential for a control-plane database that no longer exists.
  That is now **fine** — the next `aspire run` of B re-registers by itself. It is deliberately left
  in place, because leaving it is what proves the fix on the next run.
- `docs/OPEN-DEFECTS.md` records F1–F3 as fixed with the fix under each; F4 is informational, F5
  and F6 are still open and still minor.

## F1, before and after, on a throwaway database

Because a fix nobody has seen fail is not evidence. Same two tenants, same statements, the only
difference being which foreign keys the table carries. Container created and removed for this.

**Old schema — single-column foreign keys.** As tenant `B`, as `mercatus_app`, planting a line on
A's order while carrying B's own `tenant_id`:

```
BEGIN
INSERT 0 1                       <-- accepted
COMMIT
BEGIN                            <-- now tenant A, deleting ITS OWN order
DELETE 0                         <-- A cannot see the planted line
ERROR:  update or delete on table "orders" violates foreign key constraint
        "order_lines_order_id_orders_id_fk" on table "order_lines"
DETAIL:  Key is still referenced from table "order_lines".
ROLLBACK
```

**New schema — composite foreign keys.** Identical statements:

```
BEGIN
ERROR:  insert or update on table "order_lines" violates foreign key constraint
        "order_lines_order_tenant_fk"
DETAIL:  Key is not present in table "orders".
ROLLBACK
BEGIN                            <-- tenant A, deleting its own order
DELETE 0
DELETE 1                         <-- unblocked
COMMIT
```

## For the next agent

- Order numbers in `acme` and `borg` are no longer 1 — the e2e suite ran three times. That is
  expected now; nothing asserts a literal order number.
- `MERCATUS_LEAK_SABOTAGE=products pnpm --filter @mercatus/db-store test` must still go RED. The
  new F1 cases do not depend on the policies, so they stay green under sabotage — that is correct,
  they test constraints, not policies.
- The two remaining known gaps are F5/F6 (minor, documented) and the OIDC path having no automated
  coverage.
