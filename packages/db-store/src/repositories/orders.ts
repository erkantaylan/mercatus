/**
 * Orders, and the per-tenant order number (BG2).
 *
 * The number comes from a counter row taken with `select … for update` inside the order
 * transaction. Never a Postgres sequence: a sequence does not roll back, so a failed checkout
 * burns a number and the numbering is neither per-tenant nor gapless. Many jurisdictions require
 * gapless numbering on anything invoice-shaped, and every merchant expects their first order to
 * be number 1 rather than wherever the global sequence happened to be.
 *
 * The select has NO where clause. RLS finds the row (§3.5), and that is also what makes the lock
 * per-tenant: two tenants checking out at the same moment lock different rows and do not queue
 * behind each other.
 */
import { InsufficientStockError, ProductNotFoundError } from '@mercatus/core';
import { and, desc, eq, gte, sql } from 'drizzle-orm';

import type { StoreTx } from '../client.js';
import type { OrderLineRow, OrderRow } from '../schema.js';
import { orderCounters, orderLines, orders, products, shoppers } from '../schema.js';
import type { ShopperInput } from './shoppers.js';
import { upsertShopper } from './shoppers.js';

/**
 * Takes the next order number for the current tenant and advances the counter.
 *
 * Zero rows is a bug, not an empty result: it means the transaction has no tenant context, or
 * that the tenant was mirrored without its counter row. Either way, inventing a number here would
 * turn a wiring fault into silently wrong data.
 */
export async function takeOrderNumber(tx: StoreTx): Promise<number> {
  const locked = await tx
    .select({ next: orderCounters.nextNumber })
    .from(orderCounters)
    .for('update');

  if (locked.length !== 1) {
    throw new Error(
      `order_counters returned ${String(locked.length)} rows, expected exactly 1. ` +
        'Either the transaction has no tenant context, or the tenant has no counter row.',
    );
  }

  const number = locked[0]?.next;
  if (number === undefined) throw new Error('order_counters row had no next_number');

  await tx.update(orderCounters).set({ nextNumber: number + 1 });
  return number;
}

/** Created when a tenant is mirrored. Idempotent, because provisioning must be resumable (CK2). */
export async function ensureOrderCounter(tx: StoreTx, tenantId: string): Promise<void> {
  await tx.insert(orderCounters).values({ tenantId, nextNumber: 1 }).onConflictDoNothing();
}

export interface CheckoutLine {
  readonly productId: string;
  readonly qty: number;
}

export interface PlaceOrderInput {
  readonly shopper: ShopperInput;
  readonly lines: readonly CheckoutLine[];
}

export interface PlacedOrder {
  readonly orderId: string;
  readonly number: number;
  readonly totalMinor: number;
  readonly currency: string;
}

/**
 * One transaction: upsert the shopper, take the number, decrement stock, insert the order and its
 * lines. Called from inside withTenantTx, so every statement below is already tenant-scoped.
 *
 * The stock decrement is a conditional update rather than a read-then-write. `stock >= qty` in the
 * WHERE is what makes it atomic: two shoppers racing for the last unit both read 1, and exactly
 * one of them matches zero rows and gets the 409.
 */
export async function placeOrder(
  tx: StoreTx,
  tenantId: string,
  input: PlaceOrderInput,
): Promise<PlacedOrder> {
  if (input.lines.length === 0) throw new ProductNotFoundError('An order needs at least one line.');

  const shopper = await upsertShopper(tx, tenantId, input.shopper);
  const number = await takeOrderNumber(tx);

  let totalMinor = 0;
  let currency = 'TRY';
  const pending: { productId: string; title: string; unitPriceMinor: number; qty: number }[] = [];

  for (const line of input.lines) {
    // No tenant predicate: a product id from another tenant is simply invisible here, so this is
    // a 404 rather than a cross-tenant read (BE1).
    const found = await tx.select().from(products).where(eq(products.id, line.productId)).limit(1);
    const product = found[0];
    if (!product) throw new ProductNotFoundError();

    const decremented = await tx
      .update(products)
      .set({ stock: sql`${products.stock} - ${line.qty}`, updatedAt: new Date() })
      .where(and(eq(products.id, line.productId), gte(products.stock, line.qty)))
      .returning({ id: products.id });

    if (decremented.length !== 1) {
      throw new InsufficientStockError(`Not enough stock for "${product.title}".`, {
        details: { productId: product.id, requested: line.qty, available: product.stock },
      });
    }

    totalMinor += product.priceMinor * line.qty;
    currency = product.currency;
    pending.push({
      productId: product.id,
      title: product.title,
      unitPriceMinor: product.priceMinor,
      qty: line.qty,
    });
  }

  const inserted = await tx
    .insert(orders)
    .values({ tenantId, number, shopperId: shopper.id, totalMinor, currency })
    .returning({ id: orders.id });
  const order = inserted[0];
  if (!order) throw new Error('insert into orders returned no row');

  await tx.insert(orderLines).values(
    pending.map((line) => ({
      tenantId,
      orderId: order.id,
      productId: line.productId,
      titleSnapshot: line.title,
      unitPriceMinor: line.unitPriceMinor,
      qty: line.qty,
    })),
  );

  return { orderId: order.id, number, totalMinor, currency };
}

/** For the telemetry batch (CE6). A count, never an order -- CI1 is a contract term, not a knob. */
export async function countOrders(tx: StoreTx): Promise<number> {
  const counted = await tx.select({ total: sql<number>`count(*)::int` }).from(orders);
  return counted[0]?.total ?? 0;
}

export async function listOrders(
  tx: StoreTx,
  page: { limit: number; offset: number },
): Promise<{ items: OrderRow[]; total: number }> {
  const items = await tx
    .select()
    .from(orders)
    .orderBy(desc(orders.placedAt), desc(orders.number))
    .limit(page.limit)
    .offset(page.offset);
  const counted = await tx.select({ total: sql<number>`count(*)::int` }).from(orders);
  return { items, total: counted[0]?.total ?? 0 };
}

/**
 * A shopper's own orders. BI2's second condition, written out: the tenant half is RLS's, the
 * subject half is this join, and neither is ever applied without the other.
 */
export async function listOrdersForSubject(
  tx: StoreTx,
  subject: string,
  page: { limit: number; offset: number },
): Promise<{ items: OrderRow[]; total: number }> {
  const items = await tx
    .select({ order: orders })
    .from(orders)
    .innerJoin(shoppers, and(eq(shoppers.id, orders.shopperId), eq(shoppers.subject, subject)))
    .orderBy(desc(orders.number))
    .limit(page.limit)
    .offset(page.offset);
  const counted = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(orders)
    .innerJoin(shoppers, and(eq(shoppers.id, orders.shopperId), eq(shoppers.subject, subject)));
  return { items: items.map((row) => row.order), total: counted[0]?.total ?? 0 };
}

export async function findOrderById(
  tx: StoreTx,
  id: string,
): Promise<{ order: OrderRow; lines: OrderLineRow[] } | null> {
  const found = await tx.select().from(orders).where(eq(orders.id, id)).limit(1);
  const order = found[0];
  if (!order) return null;
  const lines = await tx.select().from(orderLines).where(eq(orderLines.orderId, id));
  return { order, lines };
}
