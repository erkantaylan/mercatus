# Open defects

Found by the independent RLS verifier during the overnight build. **Not yet fixed** — the schema
still has single-column foreign keys. Fix after the build run completes, before trusting the
isolation story.

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

---

## F2 — `tenants` table is readable with no tenant context

`tenants` has `relrowsecurity=f` and `mercatus_app` holds `SELECT`. Deliberate — it is the lookup
that produces the context — and the write side is properly closed. But in a **pooled** deployment
any code path holding a store connection can enumerate every merchant on the box.

**Fix.** A `SECURITY DEFINER` lookup function returning one row by slug, then revoke the direct
`SELECT`.

---

## F3 — connect boundary is one-directional

`mercatus_app` is correctly denied `CONNECT` to `mercatus_platform`. The reverse is open:
`mercatus_platform_app` can connect to `mercatus_store`, because `db-store/sql/00-roles.sql` never
does `revoke connect on database ... from public` while the db-platform file does.

Not a leak today (table grants still deny it), but any role later added to the cluster gets a free
foothold in the data plane.

**Fix.** Two lines in `db-store/sql/00-roles.sql` mirroring the platform file.

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
