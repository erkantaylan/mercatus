/**
 * Licences. One row per tenant, holding the entitlements a data plane gates features on (CC3) and
 * the date it stops being valid.
 *
 * What is NOT here: the active/passive flip. That is the tenant's status (ES, CG3) -- a licence
 * that is present says what the merchant paid for, and the tenant's status says whether they are
 * currently allowed to take money. Collapsing the two would make "suspended" and "expired"
 * indistinguishable, and they are fixed by different people.
 */
import { eq } from 'drizzle-orm';

import type { PlatformExecutor } from '../client.js';
import type { Entitlements, LicenceRow } from '../schema.js';
import { licences } from '../schema.js';

export async function findLicence(
  db: PlatformExecutor,
  tenantId: string,
): Promise<LicenceRow | null> {
  const rows = await db.select().from(licences).where(eq(licences.tenantId, tenantId)).limit(1);
  return rows[0] ?? null;
}

/**
 * Issue or re-issue. The licence `id` is kept across a re-issue: it identifies the agreement, not
 * the document, and a data plane reports it on every heartbeat (CE6). Re-issuing bumps
 * `issued_at`, which is what a poll compares against.
 */
export async function issueLicence(
  db: PlatformExecutor,
  input: { tenantId: string; validUntil: string; entitlements?: Entitlements },
): Promise<LicenceRow> {
  const entitlements = input.entitlements ?? {};
  const rows = await db
    .insert(licences)
    .values({ tenantId: input.tenantId, validUntil: input.validUntil, entitlements })
    .onConflictDoUpdate({
      target: licences.tenantId,
      set: { validUntil: input.validUntil, entitlements, issuedAt: new Date() },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('issueLicence returned no row');
  return row;
}
