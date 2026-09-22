/**
 * Payments -- buying a store.
 *
 * `provider_ref` is fake-bank's identifier and it is UNIQUE, which is what makes the callback
 * idempotent: a bank that retries, or delivers twice, settles the same row twice and changes
 * nothing the second time (CK2). It is an attribute of the payment and never anyone's key (BV1).
 */
import { eq } from 'drizzle-orm';

import type { PlatformExecutor } from '../client.js';
import type { PaymentRow, PaymentStatus } from '../schema.js';
import { payments } from '../schema.js';

export async function insertPayment(
  db: PlatformExecutor,
  input: {
    id?: string;
    tenantId: string;
    providerRef: string;
    amountMinor: number;
    currency: string;
  },
): Promise<PaymentRow> {
  const rows = await db
    .insert(payments)
    .values({
      ...(input.id === undefined ? {} : { id: input.id }),
      tenantId: input.tenantId,
      providerRef: input.providerRef,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: 'created',
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('insertPayment returned no row');
  return row;
}

export async function findPaymentByProviderRef(
  db: PlatformExecutor,
  providerRef: string,
): Promise<PaymentRow | null> {
  const rows = await db
    .select()
    .from(payments)
    .where(eq(payments.providerRef, providerRef))
    .limit(1);
  return rows[0] ?? null;
}

export async function findPaymentsByTenant(
  db: PlatformExecutor,
  tenantId: string,
): Promise<PaymentRow[]> {
  return db.select().from(payments).where(eq(payments.tenantId, tenantId));
}

/** Settling is terminal: `settled_at` is stamped once, and a second callback re-writes nothing. */
export async function settlePayment(
  db: PlatformExecutor,
  input: { id: string; status: Exclude<PaymentStatus, 'created'> },
): Promise<PaymentRow | null> {
  const rows = await db
    .update(payments)
    .set({ status: input.status, settledAt: new Date() })
    .where(eq(payments.id, input.id))
    .returning();
  return rows[0] ?? null;
}
