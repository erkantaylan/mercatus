/**
 * Products. Not one query here filters by tenant: RLS does it, and that is the point (§3.5, BE1).
 * `eq(products.id, id)` on its own is safe -- a product id belonging to another tenant simply is
 * not visible inside this transaction, so the result is "not found", not someone else's row.
 */
import { asc, eq, sql } from 'drizzle-orm';

import type { StoreTx } from '../client.js';
import type { ProductRow } from '../schema.js';
import { products } from '../schema.js';

export interface ProductInput {
  readonly sku: string;
  readonly title: string;
  readonly priceMinor: number;
  readonly currency?: string;
  readonly imageUrl?: string | null;
  readonly stock: number;
}

export type ProductPatch = Partial<ProductInput>;

export async function listProducts(
  tx: StoreTx,
  page: { limit: number; offset: number },
): Promise<{ items: ProductRow[]; total: number }> {
  const items = await tx
    .select()
    .from(products)
    .orderBy(asc(products.title))
    .limit(page.limit)
    .offset(page.offset);
  const counted = await tx.select({ total: sql<number>`count(*)::int` }).from(products);
  return { items, total: counted[0]?.total ?? 0 };
}

export async function findProductById(tx: StoreTx, id: string): Promise<ProductRow | null> {
  const rows = await tx.select().from(products).where(eq(products.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * The tenant id is written from the context, never taken from the caller. RLS's `with check`
 * rejects anything else anyway -- this just means the rejection never has to happen.
 */
export async function insertProduct(
  tx: StoreTx,
  tenantId: string,
  input: ProductInput,
): Promise<ProductRow> {
  const rows = await tx
    .insert(products)
    .values({
      tenantId,
      sku: input.sku,
      title: input.title,
      priceMinor: input.priceMinor,
      ...(input.currency === undefined ? {} : { currency: input.currency }),
      imageUrl: input.imageUrl ?? null,
      stock: input.stock,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('insert into products returned no row');
  return row;
}

export async function updateProduct(
  tx: StoreTx,
  id: string,
  patch: ProductPatch,
): Promise<ProductRow | null> {
  const rows = await tx
    .update(products)
    .set({
      ...(patch.sku === undefined ? {} : { sku: patch.sku }),
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.priceMinor === undefined ? {} : { priceMinor: patch.priceMinor }),
      ...(patch.currency === undefined ? {} : { currency: patch.currency }),
      ...(patch.imageUrl === undefined ? {} : { imageUrl: patch.imageUrl }),
      ...(patch.stock === undefined ? {} : { stock: patch.stock }),
      updatedAt: new Date(),
    })
    .where(eq(products.id, id))
    .returning();
  return rows[0] ?? null;
}

/** Returns false when the id is unknown -- or belongs to another tenant, which is the same thing. */
export async function deleteProduct(tx: StoreTx, id: string): Promise<boolean> {
  const rows = await tx.delete(products).where(eq(products.id, id)).returning({ id: products.id });
  return rows.length === 1;
}
