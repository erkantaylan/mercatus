/**
 * Order numbers are per-tenant and gapless (BG2).
 *
 * The property being tested is the one a sequence cannot give you: tenant A's first order is 1
 * and so is tenant B's, and a rolled-back checkout does not burn a number. A `serial` column
 * fails both -- nextval() does not roll back -- and the failure is invisible until a merchant
 * asks why their order numbers start at 4,712.
 */
import { randomUUID } from 'node:crypto';

import { runInTenant } from '@mercatus/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { StoreDbHandle } from '../src/client.js';
import { createStoreDb } from '../src/client.js';
import { ensureOrderCounter, placeOrder, takeOrderNumber } from '../src/repositories/orders.js';
import { insertProduct } from '../src/repositories/products.js';
import { mirrorTenant } from '../src/repositories/tenants.js';
import { withExplicitTenantTx, withTenantTx } from '../src/tenant-tx.js';

const A = { id: randomUUID(), slug: `num-a-${randomUUID().slice(0, 8)}` };
const B = { id: randomUUID(), slug: `num-b-${randomUUID().slice(0, 8)}` };

let app: StoreDbHandle | undefined;
let admin: StoreDbHandle | undefined;
const productIds = new Map<string, string>();

beforeAll(async () => {
  // The database is the one test/global-setup.ts brought up. No env var, so no silent skip.
  const urls = inject('storeDb');
  app = createStoreDb(urls.appUrl, { max: 4 });
  admin = createStoreDb(urls.adminUrl, { max: 2 });
  for (const tenant of [A, B]) {
    const productId = await withExplicitTenantTx(admin.db, tenant.id, async (tx) => {
      await mirrorTenant(tx, { id: tenant.id, slug: tenant.slug, name: tenant.slug });
      await ensureOrderCounter(tx, tenant.id);
      const product = await insertProduct(tx, tenant.id, {
        sku: 'NUM-1',
        title: 'Numbered thing',
        priceMinor: 500,
        stock: 100,
      });
      return product.id;
    });
    productIds.set(tenant.id, productId);
  }
}, 60_000);

afterAll(async () => {
  if (admin) {
    for (const tenant of [A, B]) {
      await withExplicitTenantTx(admin.db, tenant.id, async (tx) => {
        await tx.execute(sql`delete from order_lines`);
        await tx.execute(sql`delete from orders`);
        await tx.execute(sql`delete from shoppers`);
        await tx.execute(sql`delete from products`);
        await tx.execute(sql`delete from order_counters`);
      });
      await admin.db.execute(sql`delete from tenants where id = ${tenant.id}`);
    }
  }
  await app?.close();
  await admin?.close();
});

function as<T>(tenant: { id: string; slug: string }, fn: () => Promise<T>): Promise<T> {
  return runInTenant({ tenantId: tenant.id, slug: tenant.slug, source: 'token' }, fn);
}

async function checkout(tenant: { id: string; slug: string }, subject: string): Promise<number> {
  return as(tenant, () =>
    withTenantTx(app!.db, async (tx) => {
      const placed = await placeOrder(tx, tenant.id, {
        shopper: { subject, phone: `+90555${String(Math.floor(Math.random() * 9000000) + 1000000)}` },
        lines: [{ productId: productIds.get(tenant.id)!, qty: 1 }],
      });
      return placed.number;
    }),
  );
}

describe('order numbering (BG2)', () => {
  it('starts at 1 for each tenant and counts up independently', async () => {
    expect(await checkout(A, 'shopper-a1')).toBe(1);
    expect(await checkout(A, 'shopper-a2')).toBe(2);
    // B's first order is also 1. A sequence could not do this.
    expect(await checkout(B, 'shopper-b1')).toBe(1);
    expect(await checkout(A, 'shopper-a3')).toBe(3);
    expect(await checkout(B, 'shopper-b2')).toBe(2);
  });

  it('a rolled-back transaction does not burn a number', async () => {
    const before = await checkout(A, 'shopper-a4');
    await expect(
      as(A, () =>
        withTenantTx(app!.db, async (tx) => {
          await takeOrderNumber(tx);
          throw new Error('deliberate rollback');
        }),
      ),
    ).rejects.toThrow('deliberate rollback');
    const after = await checkout(A, 'shopper-a5');
    expect(after).toBe(before + 1);
  });

  it('refuses to invent a number when the transaction has no tenant context', async () => {
    // No runInTenant, so withTenantTx cannot even start: currentTenant() throws by design.
    await expect(withTenantTx(app!.db, (tx) => takeOrderNumber(tx))).rejects.toThrow(
      /tenant context/i,
    );
  });

  it('stock is decremented atomically and refuses to go negative', async () => {
    const productId = await as(A, () =>
      withTenantTx(app!.db, async (tx) => {
        const p = await insertProduct(tx, A.id, {
          sku: `SCARCE-${randomUUID().slice(0, 8)}`,
          title: 'Last one',
          priceMinor: 100,
          stock: 1,
        });
        return p.id;
      }),
    );

    const first = await as(A, () =>
      withTenantTx(app!.db, (tx) =>
        placeOrder(tx, A.id, {
          shopper: { subject: 'shopper-scarce-1', phone: '+905551111111' },
          lines: [{ productId, qty: 1 }],
        }),
      ),
    );
    expect(first.totalMinor).toBe(100);

    await expect(
      as(A, () =>
        withTenantTx(app!.db, (tx) =>
          placeOrder(tx, A.id, {
            shopper: { subject: 'shopper-scarce-2', phone: '+905552222222' },
            lines: [{ productId, qty: 1 }],
          }),
        ),
      ),
    ).rejects.toThrow(/stock/i);
  });
});
