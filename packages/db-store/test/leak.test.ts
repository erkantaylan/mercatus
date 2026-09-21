/**
 * The cross-tenant leak suite (BL1, BUILD-PLAN §9). This is the test that must exist before
 * anything is built on top of the schema, and it is the multi-tenant equivalent of a banned-
 * symbols list: the invariant is enforced mechanically, not by review.
 *
 * Every fixture seeds tenant `acme` AND tenant `borg`, because "returns only acme's rows" is not
 * a claim unless there is somewhere for it to leak from. For every RLS-protected table it asserts,
 * connected as `mercatus_app`:
 *
 *   1. inside acme's transaction, a select returns only acme's rows
 *   2. an insert carrying borg's tenant_id is rejected by `with check`
 *   3. an update or delete of a borg row inside acme's transaction affects 0 rows
 *   4. a select with NO tenant context returns 0 rows and does not throw
 *   5. `mercatus_app` does not have BYPASSRLS
 *
 * Needs a live Postgres. Bring one up and migrate it first:
 *
 *   DATABASE_SUPERUSER_URL=... DATABASE_ADMIN_URL=... pnpm --filter @mercatus/db-store migrate --seed
 *   DATABASE_URL=... DATABASE_ADMIN_URL=... pnpm --filter @mercatus/db-store test
 */
import { randomUUID } from 'node:crypto';

import { runInTenant } from '@mercatus/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { StoreDbHandle } from '../src/client.js';
import { createStoreDb } from '../src/client.js';
import { ensureOrderCounter, placeOrder } from '../src/repositories/orders.js';
import { insertProduct } from '../src/repositories/products.js';
import { mirrorTenant } from '../src/repositories/tenants.js';
import { RLS_TABLES } from '../src/schema.js';
import { withExplicitTenantTx, withTenantTx } from '../src/tenant-tx.js';

const appUrl = process.env['DATABASE_URL'];
const adminUrl = process.env['DATABASE_ADMIN_URL'];
const hasDb = Boolean(appUrl && adminUrl);

if (!hasDb) {
  // A skipped suite that nobody notices is how BL1 quietly stops being true. Say so, loudly.
  process.stderr.write(
    '\n[leak.test] SKIPPED: DATABASE_URL and DATABASE_ADMIN_URL are not set, so the ' +
      'cross-tenant leak suite did not run. See the header of this file.\n\n',
  );
}

/** Ids fixed per run so a failure names something you can go and look at. */
const ACME = { id: randomUUID(), slug: `leak-acme-${randomUUID().slice(0, 8)}` };
const BORG = { id: randomUUID(), slug: `leak-borg-${randomUUID().slice(0, 8)}` };

interface Fixture {
  productId: string;
  shopperId: string;
  shopperSubject: string;
  orderId: string;
  orderNumber: number;
  orderLineId: string;
}

const fixtures = new Map<string, Fixture>();

let app: StoreDbHandle | undefined;
let admin: StoreDbHandle | undefined;

async function seedTenant(tenant: { id: string; slug: string }): Promise<Fixture> {
  const db = admin!.db;
  return withExplicitTenantTx(db, tenant.id, async (tx) => {
    await mirrorTenant(tx, { id: tenant.id, slug: tenant.slug, name: tenant.slug });
    await ensureOrderCounter(tx, tenant.id);
    await tx.execute(
      sql`insert into licence_state (tenant_id, status) values (${tenant.id}, 'active')
          on conflict (tenant_id) do nothing`,
    );

    const product = await insertProduct(tx, tenant.id, {
      sku: `SKU-${tenant.slug}`,
      title: `Widget for ${tenant.slug}`,
      priceMinor: 1000,
      stock: 50,
    });

    const subject = `sub-${tenant.slug}`;
    const placed = await placeOrder(tx, tenant.id, {
      shopper: { subject, phone: `+9055500${String(Math.floor(Math.random() * 90000) + 10000)}` },
      lines: [{ productId: product.id, qty: 2 }],
    });

    const shopperRows = await tx.execute<{ id: string }>(sql`select id from shoppers limit 1`);
    const lineRows = await tx.execute<{ id: string }>(
      sql`select id from order_lines where order_id = ${placed.orderId} limit 1`,
    );

    return {
      productId: product.id,
      shopperId: String(shopperRows[0]?.id),
      shopperSubject: subject,
      orderId: placed.orderId,
      orderNumber: placed.number,
      orderLineId: String(lineRows[0]?.id),
    };
  });
}

beforeAll(async () => {
  if (!hasDb) return;
  app = createStoreDb(appUrl!, { max: 4 });
  admin = createStoreDb(adminUrl!, { max: 2 });
  fixtures.set(ACME.id, await seedTenant(ACME));
  fixtures.set(BORG.id, await seedTenant(BORG));
}, 60_000);

afterAll(async () => {
  if (admin) {
    // Leave the database as we found it: the fixture tenants go, the seed's stay.
    const db = admin.db;
    for (const tenant of [ACME, BORG]) {
      await withExplicitTenantTx(db, tenant.id, async (tx) => {
        await tx.execute(sql`delete from order_lines`);
        await tx.execute(sql`delete from orders`);
        await tx.execute(sql`delete from shoppers`);
        await tx.execute(sql`delete from products`);
        await tx.execute(sql`delete from licence_state`);
        await tx.execute(sql`delete from order_counters`);
      });
      await db.execute(sql`delete from tenants where id = ${tenant.id}`);
    }
  }
  await app?.close();
  await admin?.close();
});

/** Every statement below runs as mercatus_app. That is the whole point (BE2). */
function acme<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenant({ tenantId: ACME.id, slug: ACME.slug, source: 'token' }, fn);
}

describe.runIf(hasDb)('cross-tenant leak suite (BL1)', () => {
  it('connects as a role that cannot bypass RLS (BE2)', async () => {
    const rows = await app!.db.execute<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      sql`select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(rows[0]?.rolsuper).toBe(false);
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  it('every RLS table is enabled and forced in the live database, not just in the .sql file', async () => {
    const rows = await app!.db.execute<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      sql`select relname, relrowsecurity, relforcerowsecurity from pg_class
          where relnamespace = 'public'::regnamespace and relkind = 'r'`,
    );
    const byName = new Map(rows.map((r) => [r.relname, r]));
    for (const table of RLS_TABLES) {
      expect(byName.get(table)?.relrowsecurity, `${table} enable`).toBe(true);
      expect(byName.get(table)?.relforcerowsecurity, `${table} force`).toBe(true);
    }
    // And the documented exception really is the exception.
    expect(byName.get('tenants')?.relrowsecurity).toBe(false);
  });

  for (const table of RLS_TABLES) {
    describe(table, () => {
      it('inside acme, every visible row belongs to acme', async () => {
        const { mine, theirs } = await acme(() =>
          withTenantTx(app!.db, async (tx) => {
            const rows = await tx.execute<{ tenant_id: string }>(
              sql`select tenant_id from ${sql.raw(table)}`,
            );
            return {
              mine: rows.filter((r) => r.tenant_id === ACME.id).length,
              theirs: rows.filter((r) => r.tenant_id !== ACME.id).length,
            };
          }),
        );
        expect(mine).toBeGreaterThan(0);
        expect(theirs).toBe(0);
      });

      it('with no tenant context at all: 0 rows, and no error', async () => {
        const rows = await app!.db.execute<{ n: number }>(
          sql`select count(*)::int as n from ${sql.raw(table)}`,
        );
        expect(rows[0]?.n).toBe(0);
      });

      it("an update of borg's row from inside acme affects 0 rows", async () => {
        const affected = await acme(() =>
          withTenantTx(app!.db, async (tx) => {
            const rows = await tx.execute<{ tenant_id: string }>(
              sql`update ${sql.raw(table)} set tenant_id = tenant_id
                  where tenant_id = ${BORG.id} returning tenant_id`,
            );
            return rows.length;
          }),
        );
        expect(affected).toBe(0);
      });

      it("a delete of borg's row from inside acme affects 0 rows", async () => {
        const affected = await acme(() =>
          withTenantTx(app!.db, async (tx) => {
            const rows = await tx.execute<{ tenant_id: string }>(
              sql`delete from ${sql.raw(table)} where tenant_id = ${BORG.id} returning tenant_id`,
            );
            return rows.length;
          }),
        );
        expect(affected).toBe(0);
      });
    });
  }

  describe("with check: acme cannot plant a row in borg's tenant", () => {
    /**
     * Every insert below is otherwise valid -- real foreign keys, satisfiable constraints -- so
     * the only thing that can reject it is the policy.
     */
    function crossTenantInsert(table: string): ReturnType<typeof sql> {
      const borg = fixtures.get(BORG.id)!;
      switch (table) {
        case 'licence_state':
          return sql`insert into licence_state (tenant_id, status) values (${BORG.id}, 'passive')`;
        case 'products':
          return sql`insert into products (tenant_id, sku, title, price_minor, stock)
                     values (${BORG.id}, ${`SMUGGLED-${randomUUID().slice(0, 8)}`}, 'Planted by acme', 1, 1)`;
        case 'shoppers':
          return sql`insert into shoppers (tenant_id, subject, phone)
                     values (${BORG.id}, ${`smuggled-${randomUUID().slice(0, 8)}`}, '+905559999999')`;
        case 'orders':
          return sql`insert into orders (tenant_id, number, shopper_id, total_minor)
                     values (${BORG.id}, 9999, ${borg.shopperId}, 1)`;
        case 'order_lines':
          return sql`insert into order_lines (tenant_id, order_id, product_id, title_snapshot, unit_price_minor, qty)
                     values (${BORG.id}, ${borg.orderId}, ${borg.productId}, 'Planted by acme', 1, 1)`;
        case 'order_counters':
          return sql`insert into order_counters (tenant_id, next_number) values (${randomUUID()}, 1)`;
        default:
          throw new Error(`no cross-tenant insert defined for ${table}`);
      }
    }

    /**
     * Drizzle wraps a driver error in `Failed query: …` and hangs the real one off `cause`, so
     * asserting on the top-level message would pass for ANY failure -- including a typo in the
     * insert. Walk the chain and require Postgres's own 42501 / row-level security.
     */
    function explain(error: unknown): string {
      const parts: string[] = [];
      let current: unknown = error;
      for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
        parts.push(current.message);
        const code = (current as { code?: unknown }).code;
        if (typeof code === 'string') parts.push(`code=${code}`);
        current = (current as { cause?: unknown }).cause;
      }
      return parts.join(' | ');
    }

    for (const table of RLS_TABLES) {
      it(`${table} rejects it`, async () => {
        let thrown: unknown;
        try {
          await acme(() => withTenantTx(app!.db, (tx) => tx.execute(crossTenantInsert(table))));
        } catch (error) {
          thrown = error;
        }
        expect(thrown, `${table} accepted a row belonging to another tenant`).toBeDefined();
        const detail = explain(thrown);
        expect(detail).toMatch(/new row violates row-level security policy/i);
        expect(detail).toContain('code=42501');
      });
    }
  });

  describe("a shopper's own rows (BI2)", () => {
    it("acme's shopper subject does not match borg's shopper, even by name", async () => {
      const borg = fixtures.get(BORG.id)!;
      const found = await acme(() =>
        withTenantTx(app!.db, async (tx) => {
          // The tenant half is RLS's; the subject half is written out. Asking for borg's subject
          // inside acme's transaction must find nothing -- both conditions, always.
          const rows = await tx.execute<{ id: string }>(
            sql`select id from shoppers where subject = ${borg.shopperSubject}`,
          );
          return rows.length;
        }),
      );
      expect(found).toBe(0);
    });
  });
});
