/**
 * Shoppers are rows in a store, never users of the platform (CD3).
 *
 * BI2 is the rule that lives here: a shopper's token is deliberately tenant-less, so the tenant
 * comes from the route and the subject from the token, and BOTH conditions are always applied.
 * The tenant half is RLS's -- that is why nothing below writes `tenant_id = …` -- and the subject
 * half is `eq(shoppers.subject, subject)`, written out, because it is not something the database
 * can infer.
 */
import { eq } from 'drizzle-orm';

import type { StoreTx } from '../client.js';
import type { ShopperRow } from '../schema.js';
import { shoppers } from '../schema.js';

export async function findShopperBySubject(
  tx: StoreTx,
  subject: string,
): Promise<ShopperRow | null> {
  const rows = await tx.select().from(shoppers).where(eq(shoppers.subject, subject)).limit(1);
  return rows[0] ?? null;
}

export interface ShopperInput {
  readonly subject: string;
  readonly phone: string;
  readonly name?: string | null;
}

/**
 * Upsert on (tenant_id, subject) -- the composite unique, never a global one (BG1). The same
 * person shopping at two stores is two rows, which is correct: they are two customers.
 */
export async function upsertShopper(
  tx: StoreTx,
  tenantId: string,
  input: ShopperInput,
): Promise<ShopperRow> {
  const rows = await tx
    .insert(shoppers)
    .values({
      tenantId,
      subject: input.subject,
      phone: input.phone,
      name: input.name ?? null,
    })
    .onConflictDoUpdate({
      target: [shoppers.tenantId, shoppers.subject],
      set: { phone: input.phone, name: input.name ?? null },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('upsert into shoppers returned no row');
  return row;
}
