/**
 * The two-tenant fixture (BL1: *every* fixture seeds two tenants).
 *
 * "Returns only acme's rows" is not a claim unless there is somewhere for it to leak from, so
 * both tenants get a row in every RLS-protected table and the rows are made deliberately
 * asymmetric -- different counts, different SKUs -- so that a leaked row is visible in an
 * assertion rather than hidden inside an equal number.
 *
 * The shopper layout is the BI2 case, and it is the reason this file is not three lines:
 *
 *   SHARED_SUBJECT   the same person, shopping at both stores. Two shopper rows, two ids.
 *                    acme: 1 order.  borg: 2 orders.
 *   solo subject     a different person, acme only, 1 order.
 *
 * So inside acme, "this shopper's orders" must be 1. A query that forgot the tenant half returns
 * 3; a query that forgot the subject half returns 2. Both mistakes are visible, and they are
 * visible as different numbers.
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { StoreDb } from '../src/client.js';
import { ensureOrderCounter, placeOrder } from '../src/repositories/orders.js';
import { insertProduct } from '../src/repositories/products.js';
import { mirrorTenant } from '../src/repositories/tenants.js';
import { upsertShopper } from '../src/repositories/shoppers.js';
import { withExplicitTenantTx } from '../src/tenant-tx.js';

/** One person, two stores. Held in a module constant so both seeds provably use the same string. */
export const SHARED_SUBJECT = `shopper-shared-${randomUUID().slice(0, 8)}`;

export interface SeededShopper {
  readonly id: string;
  readonly subject: string;
  readonly orderIds: readonly string[];
}

export interface TenantFixture {
  readonly id: string;
  readonly slug: string;
  readonly productId: string;
  readonly productSku: string;
  /** SHARED_SUBJECT's row in THIS tenant. A different id in each tenant -- two customers. */
  readonly shared: SeededShopper;
  /** A second shopper, acme only. Exists so the subject half of BI2 has something to exclude. */
  readonly solo: SeededShopper | null;
  readonly orderIds: readonly string[];
  readonly orderLineIds: readonly string[];
}

export interface TwoTenants {
  readonly acme: TenantFixture;
  readonly borg: TenantFixture;
}

interface SeedPlan {
  readonly slug: string;
  /** Orders placed for SHARED_SUBJECT in this tenant. */
  readonly sharedOrders: number;
  /** Whether this tenant also gets a second, tenant-local shopper. */
  readonly withSolo: boolean;
}

/**
 * Runs as mercatus_owner, inside an explicit tenant transaction -- `force row level security`
 * binds the owner too, so even the seed goes through the mechanism it is seeding for. That is a
 * feature: a fixture that needed BYPASSRLS would be proving the policies are avoidable.
 */
async function seedTenant(db: StoreDb, plan: SeedPlan): Promise<TenantFixture> {
  const id = randomUUID();
  const slug = `${plan.slug}-${randomUUID().slice(0, 8)}`;

  return withExplicitTenantTx(db, id, async (tx) => {
    await mirrorTenant(tx, { id, slug, name: slug });
    await ensureOrderCounter(tx, id);
    await tx.execute(
      sql`insert into licence_state (tenant_id, status) values (${id}, 'active')
          on conflict (tenant_id) do nothing`,
    );

    const sku = `SKU-${slug}`;
    const product = await insertProduct(tx, id, {
      sku,
      title: `Widget for ${slug}`,
      priceMinor: 1_000,
      stock: 500,
    });

    const orderIds: string[] = [];

    async function order(subject: string, phone: string): Promise<string> {
      const placed = await placeOrder(tx, id, {
        shopper: { subject, phone },
        lines: [{ productId: product.id, qty: 1 }],
      });
      orderIds.push(placed.orderId);
      return placed.orderId;
    }

    const sharedOrderIds: string[] = [];
    // Created up front rather than implicitly by the first order, so a tenant with zero orders
    // for this subject would still have the shopper row.
    const sharedShopper = await upsertShopper(tx, id, {
      subject: SHARED_SUBJECT,
      phone: `+9055500${String(1000 + Math.floor(Math.random() * 8999))}`,
    });
    for (let n = 0; n < plan.sharedOrders; n += 1) {
      sharedOrderIds.push(await order(SHARED_SUBJECT, sharedShopper.phone));
    }

    let solo: SeededShopper | null = null;
    if (plan.withSolo) {
      const subject = `shopper-solo-${randomUUID().slice(0, 8)}`;
      const phone = `+9055501${String(1000 + Math.floor(Math.random() * 8999))}`;
      const row = await upsertShopper(tx, id, { subject, phone });
      const orderId = await order(subject, phone);
      solo = { id: row.id, subject, orderIds: [orderId] };
    }

    const lineRows = await tx.execute<{ id: string }>(sql`select id from order_lines`);

    return {
      id,
      slug,
      productId: product.id,
      productSku: sku,
      shared: { id: sharedShopper.id, subject: SHARED_SUBJECT, orderIds: sharedOrderIds },
      solo,
      orderIds,
      orderLineIds: lineRows.map((row) => String(row.id)),
    };
  });
}

/**
 * acme and borg. The asymmetry is deliberate: borg has two orders for the shared shopper and acme
 * has one, so "1" and "2" and "3" are three distinguishable answers in the BI2 assertions.
 */
export async function seedTwoTenants(db: StoreDb): Promise<TwoTenants> {
  const acme = await seedTenant(db, { slug: 'leak-acme', sharedOrders: 1, withSolo: true });
  const borg = await seedTenant(db, { slug: 'leak-borg', sharedOrders: 2, withSolo: false });
  return { acme, borg };
}
