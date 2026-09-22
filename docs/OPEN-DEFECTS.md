# Open defects

Found by the independent RLS verifier during the overnight build.

**F1, F2 and F3 were fixed in task 12.1** (`fix: tenant-consistent foreign keys…`). Their entries
are kept, with the fix recorded under each, because the shape of the mistake is worth more than
the note that it is gone. F4 is informational and still true; F5 and F6 are still open and still
minor.

| | | |
|---|---|---|
| **F1** | cross-tenant denial of service through single-column FKs | ✅ fixed, with leak-suite cases |
| **F2** | `tenants` readable with no tenant context | ✅ fixed, SECURITY DEFINER lookups |
| **F3** | connect boundary one-directional | ✅ fixed, `revoke connect … from public` |
| **F4** | control plane has no RLS | informational, unchanged |
| **F5** | primary-key collision is an existence oracle | open, minor |
| **F6** | a non-uuid `app.tenant_id` raises at query time | open, minor |

---

## F1 — cross-tenant write via foreign keys (real, reproduced)

**Postgres runs referential-integrity checks with row security off.** So `WITH CHECK` validates a
row's own `tenant_id` and never validates its parent.

All three data-plane FKs are single-column (`packages/db-store/src/schema.ts`):

```
order_lines.order_id   -> orders.id
order_lines.product_id -> products.id
orders.shopper_id      -> shoppers.id
```

Reproduced by the verifier: inside tenant A's transaction,

```sql
insert into order_lines (tenant_id, order_id, product_id, ...)
values (<A>, <B's order>, <B's product>, ...);   -- INSERT 1
```

The planted row carries A's `tenant_id`, so B cannot see it — and B can no longer delete its own
order or its own product:

```
ERROR: update or delete on table "orders" violates foreign key constraint
       "order_lines_order_id_orders_id_fk"
```

**Impact.** Not a confidentiality leak — no data of B's is read. It is a **cross-tenant denial of
service plus silent integrity corruption**, mountable by any tenant, costing one INSERT.

It directly contradicts the comment in `schema.ts` claiming that carrying `tenant_id` on
`order_lines` makes the child independently safe. That holds for **reads**, not for referential
integrity.

**Fix.** Make referential integrity itself tenant-consistent:

1. `unique (id, tenant_id)` on `orders`, `products`, `shoppers`
2. composite FKs:
   - `order_lines (order_id, tenant_id)` → `orders (id, tenant_id)`
   - `order_lines (product_id, tenant_id)` → `products (id, tenant_id)`
   - `orders (shopper_id, tenant_id)` → `shoppers (id, tenant_id)`
3. Add a leak-suite case. The existing 69 tests all pass and **none touch this path** — which is
   the point: a suite that is green against a real defect is exactly what `BL1` warns about.

### ✅ Fixed — task 12.1

`packages/db-store/src/schema.ts` now declares `unique (id, tenant_id)` on `orders`, `products`
and `shoppers`, and all three foreign keys are composite:

```
order_lines (order_id, tenant_id)   -> orders   (id, tenant_id)
order_lines (product_id, tenant_id) -> products (id, tenant_id)
orders      (shopper_id, tenant_id) -> shoppers (id, tenant_id)
```

The migrations were **regenerated as one file** rather than patched: drizzle-kit emitted the new
unique constraints *after* the foreign keys that reference them, which Postgres refuses, and
hand-ordering generated SQL is what `J1` is about. Every database in this repo is created fresh
per run, so a squash costs nothing.

`packages/db-store/test/leak.test.ts` grew a `referential integrity is tenant-consistent (F1)`
section: a **structural** case asserting that every foreign key in the live database carries
`tenant_id` (so the next single-column FK fails a test rather than shipping), the three attack
inserts, and the victim's half — borg deleting its own order and product afterwards.

---

## F2 — `tenants` table is readable with no tenant context

`tenants` has `relrowsecurity=f` and `mercatus_app` holds `SELECT`. Deliberate — it is the lookup
that produces the context — and the write side is properly closed. But in a **pooled** deployment
any code path holding a store connection can enumerate every merchant on the box.

**Fix.** A `SECURITY DEFINER` lookup function returning one row by slug, then revoke the direct
`SELECT`.

### ✅ Fixed — task 12.1

`sql/02-rls.sql` revokes the table grant and creates three definer functions, each returning only
what its caller needs:

| | |
|---|---|
| `mercatus_tenant_by_slug(text)` | one row — the request's tenant candidate (§3.6) |
| `mercatus_tenant_by_id(uuid)` | one row — the tenant the token already established |
| `mercatus_tenant_directory()` | **id and slug only** — the pooled licence agent's poll list |

The directory exists because the pooled agent must enumerate what the instance serves, and that
list cannot come from an RLS-protected table: it *is* the set of contexts. It returns no name and
no branding, so the bulk read of merchant data is gone even though enumeration remains.

Each function pins `search_path` (without it the caller chooses which `tenants` the body reads)
and has `EXECUTE` revoked from `PUBLIC`, which is granted by default and would otherwise be the
leak. `repositories/tenants.ts` reads through them; the owner still uses the table directly, which
is why the write helpers are unchanged.

---

## F3 — connect boundary is one-directional

`mercatus_app` is correctly denied `CONNECT` to `mercatus_platform`. The reverse is open:
`mercatus_platform_app` can connect to `mercatus_store`, because `db-store/sql/00-roles.sql` never
does `revoke connect on database ... from public` while the db-platform file does.

Not a leak today (table grants still deny it), but any role later added to the cluster gets a free
foothold in the data plane.

**Fix.** Two lines in `db-store/sql/00-roles.sql` mirroring the platform file.

### ✅ Fixed — task 12.1

`revoke connect on database %I from public` now runs before the grants to `mercatus_owner` and
`mercatus_app`, and the leak suite asserts it against the live database by counting `CONNECT`
grants to grantee 0 (`PUBLIC`) in `pg_database.datacl`.

---

## F4 — control plane has no RLS at all (informational)

All six `db-platform` tables are `relrowsecurity=f`, four of them carry `tenant_id`, and
`mercatus_platform_app` holds full CRUD. Documented as intentional ("one tenant, which is us"), so
not a bug — but per-tenant scoping there is application code only, with none of the fail-closed
property the data plane has. **If the platform API ever serves a merchant-facing view, this is
where the next leak comes from.**

---

## F5, F6 — minor

- **F5.** Primary-key collision is an existence oracle: inserting a product with another tenant's
  known product UUID fails with `duplicate key` rather than an RLS error. Only exploitable against
  a UUID you already hold.
- **F6.** A non-UUID `app.tenant_id` raises `invalid input syntax for type uuid` at query time
  rather than at `set_config` time. Fails closed, but the error surfaces far from its cause.

---

*Source: the independent verifier in the `Data` phase, which stood up its own throwaway Postgres,
applied the migrations, and attacked the schema as `mercatus_app` rather than trusting the
builder's report. It also confirmed the project's own suite genuinely runs and passes — the tests
were not fabricated, just incomplete.*

---

## Still shipping at v2.0.0 — stated, not fixed

Repair round 1 fixed one defect class (both browser front ends could only sign in through routes
that exist under `AUTH_ADAPTER=stub`) and deliberately did not touch these. They are listed here,
with what each one actually costs, so that "accepted with known defects" is a sentence somebody
wrote rather than something a reader has to infer.

| | What is wrong | What it costs today | Where |
|---|---|---|---|
| **EV** | a **running** AppHost B never recovers when the control plane is rebuilt. Re-registration happens only at B's start | `aspire stop` on A destroys A's Postgres, so the installation is gone and B's instance token answers 401 for ever. Restarting B fixes it in one poll. The e2e suite's outage test kills the platform PROCESS instead, which recovers correctly | `apps/store/src/provision.ts`; the fix is the same branch in `apps/store/src/agents/licence-poll.ts` |
| **EW** | one port covers HTML and nothing else | every SPA XHR and the whole payment leg leave the edge: `VITE_STORE_API_URL`, `VITE_PLATFORM_URL` and `FAKE_BANK_URL` are direct addresses. Firewall everything but `:28080` and checkout breaks | `aspire/AppHostA/apphost.cs` |
| **EX** | CORS is `origin: true, credentials: true` on every API | any origin is reflected and allowed to send credentials. It is also what keeps EW invisible, because nothing ever complains about the cross-origin call | `packages/core/src/http/server.ts` |
| **CE2** | the storefront signs fake-bank requests itself, **including on a customer-owned box** | a merchant with root on their own server holds a key that can sign payment requests that bill us. `POST /payments/proxy` was never built | `aspire/AppHostB/apphost.cs` sets `FAKE_BANK_HMAC_SECRET` on the storefront |
| **EY** | the merchant cannot see who bought | the order detail renders number, status, payment reference, lines and total, and no shopper. The data is in the store and RLS-protected; this is a gap in the dashboard | `apps/dashboard/src/routes/orders.$id.tsx` |

**EZ is narrower than it was.** "The OIDC path has no automated coverage at all" is no longer
true: `packages/e2e/tests/05-oidc-four-tenants.spec.ts` drives the whole four-tenant demo in a
real browser against `AUTH_ADAPTER=oidc`, and `MERCATUS_E2E_REQUIRE_OIDC=1` makes its absence a
failure rather than a skip. What remains of EZ is that `pnpm -r test` still does not include any
of the browser suite, because `packages/e2e` declares `test:e2e` and no `test` script — the
headline command is still not the headline check.
