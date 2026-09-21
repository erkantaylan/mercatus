/**
 * What this store believes about its licence (CG3).
 *
 * Two facts, kept apart on purpose: `status` is the tenant's own state -- passive blocks checkout
 * and leaves the dashboard fully usable -- and `last_success_at` is ours, the clock the grace
 * window is measured from. Collapsing them makes our outage look to the merchant exactly like
 * being cut off for non-payment, and takes away the page that fixes it.
 */
import { sql } from 'drizzle-orm';

import type { StoreTx } from '../client.js';
import type { Entitlements, LicenceStateRow } from '../schema.js';
import { licenceState } from '../schema.js';

/** No where clause: there is exactly one row per tenant and RLS is what finds it. */
export async function readLicenceState(tx: StoreTx): Promise<LicenceStateRow | null> {
  const rows = await tx.select().from(licenceState).limit(1);
  return rows[0] ?? null;
}

export interface LicencePollResult {
  readonly status: 'active' | 'passive';
  readonly entitlements: Entitlements;
  readonly validUntil: string | null;
}

/** A poll that reached the control plane (CE4: we pull, we are never pushed to). */
export async function recordLicenceSuccess(
  tx: StoreTx,
  tenantId: string,
  result: LicencePollResult,
): Promise<void> {
  const now = new Date();
  await tx
    .insert(licenceState)
    .values({
      tenantId,
      status: result.status,
      entitlements: result.entitlements,
      validUntil: result.validUntil,
      lastCheckedAt: now,
      lastSuccessAt: now,
    })
    .onConflictDoUpdate({
      target: licenceState.tenantId,
      set: {
        status: result.status,
        entitlements: result.entitlements,
        validUntil: result.validUntil,
        lastCheckedAt: now,
        lastSuccessAt: now,
      },
    });
}

/**
 * A poll that did not reach the control plane. Touches `last_checked_at` and deliberately NOT
 * `status`: unreachable is not passive, and the cached status stands until the grace window ends.
 */
export async function recordLicenceAttempt(tx: StoreTx): Promise<void> {
  await tx.update(licenceState).set({ lastCheckedAt: sql`now()` });
}
