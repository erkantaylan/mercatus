/**
 * The cross-tenant leak suite (BL1, BUILD-PLAN §9). The most valuable test in the repo, and the
 * multi-tenant equivalent of a banned-symbols list: the invariant is enforced mechanically, not
 * by review.
 *
 * It brings up its own Postgres (test/global-setup.ts), so it cannot skip itself into a green
 * run, and every statement below is issued as `mercatus_app` -- LOGIN, NOBYPASSRLS, no schema
 * privileges. That is the whole of BE2: connect the app as a superuser and every policy in
 * sql/02-rls.sql silently becomes a comment, with no symptom except that queries start returning
 * other tenants' rows.
 *
 * Per RLS table, inside tenant acme's transaction:
 *
 *   1. every visible row belongs to acme, and there is at least one   (a vacuous pass is a lie)
 *   2. a direct lookup of borg's row, by its own primary key, finds nothing
 *   3. an update targeting borg's rows affects 0 rows
 *   4. a delete targeting borg's rows affects 0 rows
 *   5. an insert carrying borg's tenant_id is refused by `with check` -- 42501, from Postgres
 *   6. with NO tenant context at all: 0 rows, and no error (fail closed, quietly)
 *
 * Then three things a per-table loop does not reach:
 *
 *   - the forgotten WHERE clause (BE1's actual failure mode): an unfiltered `delete from <every
 *     table>` inside acme, rolled back, leaves every one of borg's row counts unchanged
 *   - `tenants`, the one table without RLS, is protected by grants instead -- select yes, write no
 *   - BI2: the shared shopper. The same person shops at both stores, and store A must not serve
 *     that person their store-B rows even though the subject on the token matches
 *
 * To prove the suite is not green against broken isolation:
 *
 *   MERCATUS_LEAK_SABOTAGE=products pnpm --filter @mercatus/db-store test    # must be RED
 *   pnpm --filter @mercatus/db-store test                                    # must be GREEN
 */
import { randomUUID } from 'node:crypto';

import { runInTenant } from '@mercatus/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { StoreDbHandle } from '../src/client.js';
import { createStoreDb } from '../src/client.js';
import { findOrderById, listOrdersForSubject } from '../src/repositories/orders.js';
import { findShopperBySubject } from '../src/repositories/shoppers.js';
import { RLS_TABLES } from '../src/schema.js';
import type { RlsTable } from '../src/schema.js';
import { withTenantTx } from '../src/tenant-tx.js';
import type { TenantFixture, TwoTenants } from './fixture.js';
import { SHARED_SUBJECT, seedTwoTenants } from './fixture.js';

let app: StoreDbHandle;
let admin: StoreDbHandle;
let tenants: TwoTenants;

const acmeOf = (): TenantFixture => tenants.acme;
const borgOf = (): TenantFixture => tenants.borg;

beforeAll(async () => {
  const urls = inject('storeDb');
  app = createStoreDb(urls.appUrl, { max: 4 });
  admin = createStoreDb(urls.adminUrl, { max: 2 });
  tenants = await seedTwoTenants(admin.db);
});

afterAll(async () => {
  await app?.close();
  await admin?.close();
});

/** Everything the suite asserts happens inside here: as mercatus_app, in acme's context. */
function acme<T>(fn: () => Promise<T>): Promise<T> {
  const t = acmeOf();
  return runInTenant({ tenantId: t.id, slug: t.slug, source: 'token' }, () => fn());
}

function borg<T>(fn: () => Promise<T>): Promise<T> {
  const t = borgOf();
  return runInTenant({ tenantId: t.id, slug: t.slug, source: 'token' }, () => fn());
}

/**
 * Drizzle wraps every driver error as `Failed query: <sql>` and hangs the real PostgresError off
 * `.cause`, so asserting on the top-level message would pass for ANY failure -- including a typo
 * in the test's own fixture. Walk the chain and require Postgres's own words and its SQLSTATE.
 */
function explain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 6; depth += 1) {
    parts.push(current.message);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') parts.push(`code=${code}`);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

async function capture(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return explain(error);
  }
  return '';
}

/** Where borg's row lives in each table, so the suite can ask for it by name and be told no. */
const BORG_ROW: Record<RlsTable, (b: TenantFixture) => { column: string; value: string }> = {
  licence_state: (b) => ({ column: 'tenant_id', value: b.id }),
  products: (b) => ({ column: 'id', value: b.productId }),
  shoppers: (b) => ({ column: 'id', value: b.shared.id }),
  orders: (b) => ({ column: 'id', value: b.orderIds[0] ?? '' }),
  order_lines: (b) => ({ column: 'id', value: b.orderLineIds[0] ?? '' }),
  order_counters: (b) => ({ column: 'tenant_id', value: b.id }),
};

/**
 * An insert that is valid in every respect except the tenant it names -- real foreign keys,
 * satisfiable checks -- so the only thing left that can reject it is the policy.
 */
function crossTenantInsert(table: RlsTable, b: TenantFixture): ReturnType<typeof sql> {
  const tag = randomUUID().slice(0, 8);
  switch (table) {
    case 'licence_state':
      return sql`insert into licence_state (tenant_id, status) values (${b.id}, 'passive')`;
    case 'products':
      return sql`insert into products (tenant_id, sku, title, price_minor, stock)
                 values (${b.id}, ${`SMUGGLED-${tag}`}, 'Planted by acme', 1, 1)`;
    case 'shoppers':
      return sql`insert into shoppers (tenant_id, subject, phone)
                 values (${b.id}, ${`smuggled-${tag}`}, ${`+9059${tag.slice(0, 7)}`})`;
    case 'orders':
      return sql`insert into orders (tenant_id, number, shopper_id, total_minor)
                 values (${b.id}, 999999, ${b.shared.id}, 1)`;
    case 'order_lines':
      return sql`insert into order_lines (tenant_id, order_id, product_id, title_snapshot, unit_price_minor, qty)
                 values (${b.id}, ${b.orderIds[0]}, ${b.productId}, 'Planted by acme', 1, 1)`;
    case 'order_counters':
      // A brand-new tenant id: order_counters is keyed by tenant_id, so borg's own row would
      // collide on the primary key and the test would pass for the wrong reason.
      return sql`insert into order_counters (tenant_id, next_number) values (${randomUUID()}, 1)`;
  }
}

describe('cross-tenant leak suite (BL1)', () => {
  describe('the ground the rest of the suite stands on', () => {
    it('connects as a role that can neither bypass RLS nor act as superuser (BE2)', async () => {
      const rows = await app.db.execute<{
        rolname: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>(sql`select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user`);
      expect(rows[0]?.rolname).toBe('mercatus_app');
      expect(rows[0]?.rolsuper, 'a superuser bypasses RLS even with FORCE').toBe(false);
      expect(rows[0]?.rolbypassrls).toBe(false);
    });

    it('every RLS table is enabled AND forced in the live database, not just in the .sql file', async () => {
      const rows = await app.db.execute<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        sql`select relname, relrowsecurity, relforcerowsecurity from pg_class
            where relnamespace = 'public'::regnamespace and relkind = 'r'`,
      );
      const byName = new Map(rows.map((r) => [r.relname, r]));
      for (const table of RLS_TABLES) {
        expect(byName.get(table)?.relrowsecurity, `${table} enable`).toBe(true);
        expect(byName.get(table)?.relforcerowsecurity, `${table} force`).toBe(true);
      }
      // And the documented exception really is the exception, not an oversight.
      expect(byName.get('tenants')?.relrowsecurity).toBe(false);
    });

    it('the app role cannot switch its own policies off', async () => {
      const detail = await capture(() =>
        app.db.execute(sql`alter table products disable row level security`),
      );
      expect(detail, 'mercatus_app was allowed to disable RLS on products').not.toBe('');
      expect(detail).toMatch(/must be (the )?owner|permission denied/i);
    });
  });

  for (const table of RLS_TABLES) {
    describe(table, () => {
      it('inside acme, every visible row belongs to acme -- and there is at least one', async () => {
        const { mine, theirs } = await acme(() =>
          withTenantTx(app.db, async (tx) => {
            const rows = await tx.execute<{ tenant_id: string }>(
              sql`select tenant_id from ${sql.raw(table)}`,
            );
            return {
              mine: rows.filter((r) => r.tenant_id === acmeOf().id).length,
              theirs: rows.filter((r) => r.tenant_id !== acmeOf().id),
            };
          }),
        );
        expect(mine, `${table} had no acme rows, so "no borg rows" proves nothing`).toBeGreaterThan(0);
        expect(theirs).toEqual([]);
      });

      it("a direct lookup of borg's row, by its own primary key, finds nothing", async () => {
        const target = BORG_ROW[table](borgOf());
        expect(target.value, `fixture did not record a borg row for ${table}`).not.toBe('');
        const found = await acme(() =>
          withTenantTx(app.db, async (tx) => {
            const rows = await tx.execute(
              sql`select 1 from ${sql.raw(table)} where ${sql.raw(target.column)} = ${target.value}::uuid`,
            );
            return rows.length;
          }),
        );
        expect(found).toBe(0);
      });

      it("an update of borg's rows from inside acme affects 0 rows", async () => {
        const affected = await acme(() =>
          withTenantTx(app.db, async (tx) => {
            const rows = await tx.execute<{ tenant_id: string }>(
              sql`update ${sql.raw(table)} set tenant_id = tenant_id
                  where tenant_id = ${borgOf().id} returning tenant_id`,
            );
            return rows.length;
          }),
        );
        expect(affected).toBe(0);
      });

      it("a delete of borg's rows from inside acme affects 0 rows", async () => {
        const affected = await acme(() =>
          withTenantTx(app.db, async (tx) => {
            const rows = await tx.execute<{ tenant_id: string }>(
              sql`delete from ${sql.raw(table)} where tenant_id = ${borgOf().id} returning tenant_id`,
            );
            return rows.length;
          }),
        );
        expect(affected).toBe(0);
      });

      it("`with check` refuses an insert carrying borg's tenant_id", async () => {
        const detail = await capture(() =>
          acme(() => withTenantTx(app.db, (tx) => tx.execute(crossTenantInsert(table, borgOf())))),
        );
        expect(detail, `${table} accepted a row belonging to another tenant`).not.toBe('');
        expect(detail).toMatch(/new row violates row-level security policy/i);
        expect(detail).toContain('code=42501');
      });

      it('with no tenant context at all: 0 rows, and no error', async () => {
        // The nullif in the policy is what makes this a zero rather than
        // `invalid input syntax for type uuid: ""` on a pooled connection that served a tenant
        // earlier in its life. Fail closed, quietly, every time.
        const rows = await app.db.execute<{ n: number }>(
          sql`select count(*)::int as n from ${sql.raw(table)}`,
        );
        expect(rows[0]?.n).toBe(0);
      });
    });
  }

  describe('the forgotten WHERE clause (BE1)', () => {
    /** Thrown to roll the transaction back. The assertions are read before it is thrown. */
    class RollbackSignal extends Error {
      public override readonly name = 'RollbackSignal';
    }

    /** Children before parents: the deletes must not fail on a foreign key and look like a pass. */
    const DELETE_ORDER: readonly RlsTable[] = [
      'order_lines',
      'orders',
      'products',
      'shoppers',
      'licence_state',
      'order_counters',
    ];

    it("an unfiltered delete of every table inside acme leaves borg's rows untouched", async () => {
      const before = await borg(() =>
        withTenantTx(app.db, async (tx) => {
          const counts: Record<string, number> = {};
          for (const table of RLS_TABLES) {
            const rows = await tx.execute<{ n: number }>(
              sql`select count(*)::int as n from ${sql.raw(table)}`,
            );
            counts[table] = rows[0]?.n ?? -1;
          }
          return counts;
        }),
      );
      // Every table has something to lose, or "unchanged" is not a claim.
      for (const table of RLS_TABLES) expect(before[table], table).toBeGreaterThan(0);

      const deleted: Record<string, number> = {};
      let after: Record<string, number> = {};
      try {
        await app.db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.tenant_id', ${acmeOf().id}, true)`);
          for (const table of DELETE_ORDER) {
            // No where clause at all. This is the bug BE1 is built to survive: RLS is the only
            // thing standing between a runaway statement and every other tenant's data.
            const rows = await tx.execute(sql`delete from ${sql.raw(table)} returning tenant_id`);
            deleted[table] = rows.length;
          }
          // Same transaction, borg's context: what survived the scorched earth?
          await tx.execute(sql`select set_config('app.tenant_id', ${borgOf().id}, true)`);
          const counts: Record<string, number> = {};
          for (const table of RLS_TABLES) {
            const rows = await tx.execute<{ n: number }>(
              sql`select count(*)::int as n from ${sql.raw(table)}`,
            );
            counts[table] = rows[0]?.n ?? -1;
          }
          after = counts;
          throw new RollbackSignal('rolling back the scorched-earth probe');
        });
      } catch (error) {
        if ((error as { name?: string }).name !== 'RollbackSignal') throw error;
      }

      // The delete really did run -- it removed acme's rows, so the comparison is meaningful.
      for (const table of DELETE_ORDER) expect(deleted[table], `${table} deleted`).toBeGreaterThan(0);
      expect(after).toEqual(before);
    });
  });

  describe('tenants: the one table without RLS is held by grants instead', () => {
    it('the app role may NOT read the table directly any more (OPEN-DEFECTS F2)', async () => {
      // It used to hold SELECT, which in a pooled deployment means any code path with a store
      // connection can enumerate every merchant on the box, with no tenant context at all.
      const detail = await capture(() =>
        app.db.execute(sql`select id, name, branding from tenants`),
      );
      expect(detail, 'mercatus_app can still read the tenants table').not.toBe('');
      expect(detail).toContain('code=42501');
      expect(detail).toMatch(/permission denied/i);
    });

    it('it reads ONE tenant at a time, through the SECURITY DEFINER lookup', async () => {
      const rows = await app.db.execute<{ id: string; slug: string }>(
        sql`select id, slug from mercatus_tenant_by_slug(${acmeOf().slug})`,
      );
      expect(rows.length).toBe(1);
      expect(rows[0]?.id).toBe(acmeOf().id);

      const byId = await app.db.execute<{ slug: string }>(
        sql`select slug from mercatus_tenant_by_id(${borgOf().id}::uuid)`,
      );
      expect(byId[0]?.slug).toBe(borgOf().slug);
    });

    it('the poll directory returns id and slug and nothing else', async () => {
      const rows = await app.db.execute<Record<string, unknown>>(
        sql`select * from mercatus_tenant_directory()`,
      );
      expect(rows.length).toBeGreaterThanOrEqual(2);
      // No name, no branding: a poll list is not a customer list.
      expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['id', 'slug']);
    });

    for (const [what, statement] of [
      ['insert', (): ReturnType<typeof sql> =>
        sql`insert into tenants (id, slug, name) values (${randomUUID()}, ${`x-${randomUUID().slice(0, 8)}`}, 'x')`],
      ['update', (): ReturnType<typeof sql> =>
        sql`update tenants set name = 'stolen' where id = ${borgOf().id}`],
      ['delete', (): ReturnType<typeof sql> => sql`delete from tenants where id = ${borgOf().id}`],
    ] as const) {
      it(`the app role cannot ${what} it`, async () => {
        const detail = await capture(() => app.db.execute(statement()));
        expect(detail, `mercatus_app was allowed to ${what} tenants`).not.toBe('');
        expect(detail).toContain('code=42501');
        expect(detail).toMatch(/permission denied/i);
      });
    }
  });

  /**
   * BI2, the subtle one. A shopper's token is deliberately tenant-less, so the tenant comes from
   * the route and the subject from the token, and NEITHER is ever applied without the other.
   *
   * The fixture makes the two halves fail differently. One person holds SHARED_SUBJECT and shops
   * at both stores: acme has 1 of their orders, borg has 2. Inside acme the right answer is 1.
   * A query that dropped the tenant condition returns 3; one that dropped the subject condition
   * returns 2 (acme's shared order plus its other shopper's). Three distinguishable numbers.
   */
  describe('a shopper reading their own rows scoped to the other store (BI2)', () => {
    it('the same subject is two different shopper rows, one per store', async () => {
      expect(acmeOf().shared.subject).toBe(SHARED_SUBJECT);
      expect(borgOf().shared.subject).toBe(SHARED_SUBJECT);
      expect(acmeOf().shared.id).not.toBe(borgOf().shared.id);
    });

    it("inside acme, the shared subject resolves to acme's shopper row, never borg's", async () => {
      const row = await acme(() =>
        withTenantTx(app.db, (tx) => findShopperBySubject(tx, SHARED_SUBJECT)),
      );
      expect(row).not.toBeNull();
      expect(row?.id).toBe(acmeOf().shared.id);
      expect(row?.tenantId).toBe(acmeOf().id);
    });

    it('inside acme, that shopper has 1 order -- not the 3 they have platform-wide', async () => {
      const seen = await acme(() =>
        withTenantTx(app.db, (tx) => listOrdersForSubject(tx, SHARED_SUBJECT, { limit: 50, offset: 0 })),
      );
      expect(seen.total).toBe(1);
      expect(seen.items.map((o) => o.id).sort()).toEqual([...acmeOf().shared.orderIds].sort());
      for (const order of seen.items) expect(order.tenantId).toBe(acmeOf().id);
    });

    it('inside borg, the same subject has 2 -- so the 1 above is scoping, not an empty table', async () => {
      const seen = await borg(() =>
        withTenantTx(app.db, (tx) => listOrdersForSubject(tx, SHARED_SUBJECT, { limit: 50, offset: 0 })),
      );
      expect(seen.total).toBe(2);
      expect(seen.items.map((o) => o.id).sort()).toEqual([...borgOf().shared.orderIds].sort());
    });

    it("asking store acme for an order the shopper really owns -- at borg -- is a not-found", async () => {
      const borgOrderId = borgOf().shared.orderIds[0] ?? '';
      expect(borgOrderId).not.toBe('');
      const found = await acme(() => withTenantTx(app.db, (tx) => findOrderById(tx, borgOrderId)));
      expect(found).toBeNull();
    });

    it("borg's shopper id, presented to acme, matches nothing", async () => {
      const rows = await acme(() =>
        withTenantTx(app.db, async (tx) =>
          tx.execute(sql`select 1 from orders where shopper_id = ${borgOf().shared.id}::uuid`),
        ),
      );
      expect(rows.length).toBe(0);
    });

    it('the subject half is real too: acme\'s other shopper\'s orders are not returned', async () => {
      const solo = acmeOf().solo;
      expect(solo, 'fixture is missing acme\'s second shopper').not.toBeNull();
      const seen = await acme(() =>
        withTenantTx(app.db, (tx) => listOrdersForSubject(tx, solo!.subject, { limit: 50, offset: 0 })),
      );
      expect(seen.total).toBe(1);
      expect(seen.items.map((o) => o.id)).toEqual([...solo!.orderIds]);
      // and the shared shopper's order is NOT in there
      for (const id of acmeOf().shared.orderIds) {
        expect(seen.items.map((o) => o.id)).not.toContain(id);
      }
    });

    it('a raw subject-only select inside acme still sees exactly one shopper', async () => {
      // The query the application must never write -- subject with no tenant condition. RLS is
      // what keeps it correct, which is exactly why no repository is allowed to add a tenant
      // filter of its own (§3.5): a filter here would hide whether the policy works.
      const rows = await acme(() =>
        withTenantTx(app.db, (tx) =>
          tx.execute<{ tenant_id: string }>(
            sql`select tenant_id from shoppers where subject = ${SHARED_SUBJECT}`,
          ),
        ),
      );
      expect(rows.length).toBe(1);
      expect(rows[0]?.tenant_id).toBe(acmeOf().id);
    });
  });

  /**
   * OPEN-DEFECTS F1 -- the defect this suite was GREEN against.
   *
   * Postgres runs referential-integrity checks with row security OFF. A single-column foreign key
   * therefore lets a row whose OWN tenant_id passes `with check` point at another tenant's parent:
   * acme inserts an order_line carrying acme's tenant_id but naming borg's order and borg's
   * product. Borg cannot see the planted row and can never again delete that order or that
   * product -- a cross-tenant denial of service costing one INSERT, reproduced live on the demo
   * database before this was fixed.
   *
   * The fix is `unique (id, tenant_id)` on the parents and composite foreign keys, so the tenant
   * is INSIDE the constraint. The first test below is structural on purpose: it fails the moment
   * anybody adds a single-column FK to this schema, which is the only way to keep a suite honest
   * about a class of bug rather than one instance of it (BL1).
   */
  describe('referential integrity is tenant-consistent (F1)', () => {
    it('EVERY foreign key in the data plane carries tenant_id', async () => {
      const rows = await app.db.execute<{ conname: string; tbl: string; cols: string[] }>(
        sql`select con.conname,
                   con.conrelid::regclass::text as tbl,
                   array_agg(att.attname order by att.attname) as cols
            from pg_constraint con
            join unnest(con.conkey) as k(attnum) on true
            join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
            where con.contype = 'f' and con.connamespace = 'public'::regnamespace
            group by con.conname, con.conrelid`,
      );
      expect(rows.length, 'no foreign keys found at all -- the query is wrong').toBeGreaterThan(0);
      const naked = rows.filter((r) => !r.cols.includes('tenant_id'));
      expect(
        naked.map((r) => `${r.tbl}.${r.conname} (${r.cols.join(', ')})`),
        'a single-column foreign key is a cross-tenant denial of service (F1)',
      ).toEqual([]);
    });

    it("acme cannot plant an order_line on borg's order", async () => {
      const detail = await capture(() =>
        acme(() =>
          withTenantTx(app.db, (tx) =>
            tx.execute(
              sql`insert into order_lines (tenant_id, order_id, product_id, title_snapshot, unit_price_minor, qty)
                  values (${acmeOf().id}, ${borgOf().orderIds[0]}::uuid, ${acmeOf().productId}::uuid,
                          'Planted by acme', 1, 1)`,
            ),
          ),
        ),
      );
      expect(detail, "acme planted a line on borg's order").not.toBe('');
      // 23503: the FK itself refuses it now, rather than accepting a row that RLS then hides.
      expect(detail).toContain('code=23503');
    });

    it("acme cannot plant an order_line on borg's product", async () => {
      const detail = await capture(() =>
        acme(() =>
          withTenantTx(app.db, (tx) =>
            tx.execute(
              sql`insert into order_lines (tenant_id, order_id, product_id, title_snapshot, unit_price_minor, qty)
                  values (${acmeOf().id}, ${acmeOf().orderIds[0]}::uuid, ${borgOf().productId}::uuid,
                          'Planted by acme', 1, 1)`,
            ),
          ),
        ),
      );
      expect(detail, "acme planted a line naming borg's product").not.toBe('');
      expect(detail).toContain('code=23503');
    });

    it("acme cannot attach its own order to borg's shopper", async () => {
      const detail = await capture(() =>
        acme(() =>
          withTenantTx(app.db, (tx) =>
            tx.execute(
              sql`insert into orders (tenant_id, number, shopper_id, total_minor)
                  values (${acmeOf().id}, 999123, ${borgOf().shared.id}::uuid, 1)`,
            ),
          ),
        ),
      );
      expect(detail, "acme attached an order to borg's shopper").not.toBe('');
      expect(detail).toContain('code=23503');
    });

    it('and borg can still delete its own order and its own product afterwards', async () => {
      // The victim's half of the attack: the planted row was invisible to borg and blocked every
      // future delete. Rolled back, because the fixture's rows are the rest of the suite's.
      class RollbackSignal extends Error {
        public override readonly name = 'RollbackSignal';
      }
      let deletedOrders = 0;
      let deletedProducts = 0;
      try {
        await app.db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.tenant_id', ${borgOf().id}, true)`);
          await tx.execute(sql`delete from order_lines`);
          const orders = await tx.execute(sql`delete from orders returning id`);
          deletedOrders = orders.length;
          const products = await tx.execute(sql`delete from products returning id`);
          deletedProducts = products.length;
          throw new RollbackSignal('rolling back the victim probe');
        });
      } catch (error) {
        if ((error as { name?: string }).name !== 'RollbackSignal') throw error;
      }
      expect(deletedOrders).toBeGreaterThan(0);
      expect(deletedProducts).toBeGreaterThan(0);
    });
  });

  describe('the connect boundary (F3)', () => {
    it('PUBLIC cannot connect to the data plane database', async () => {
      // db-platform has always done this; db-store never did, so any role later added to the
      // cluster got a free foothold here. Table grants denied it today -- a boundary that
      // depends on nobody ever adding a role is not a boundary.
      const rows = await app.db.execute<{ n: number }>(
        sql`select count(*)::int as n
            from aclexplode((select datacl from pg_database where datname = current_database()))
            where grantee = 0 and privilege_type = 'CONNECT'`,
      );
      expect(rows[0]?.n, 'connect is still granted to PUBLIC on this database').toBe(0);
    });
  });

});
