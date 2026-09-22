/**
 * Installations -- a dedicated instance that registered itself (CE7).
 *
 * Every credential is stored as a sha256 hash and never in clear: the bootstrap token is shown
 * exactly once and nulled the moment it is spent, and the instance token is per-instance and
 * individually revocable (CE1). One leaked key on one merchant's VPS must not be a platform-wide
 * incident, and it cannot be one if there is no platform-wide key to leak.
 *
 * `version`, `licence_id` and the two counts are REPORTED by a box whose owner has root. They are
 * telemetry, not metering (CE3, CJ1) -- limits are enforced through the signed licence.
 */
import { createHash } from 'node:crypto';

import { desc, eq, isNotNull } from 'drizzle-orm';

import type { PlatformExecutor } from '../client.js';
import type { InstallationRow } from '../schema.js';
import { installations } from '../schema.js';

/** The only way a token is compared: hash what arrived, look the hash up. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export async function insertInstallation(
  db: PlatformExecutor,
  input: { tenantId: string; bootstrapTokenHash: string; expectedHost: string },
): Promise<InstallationRow> {
  const rows = await db
    .insert(installations)
    .values({
      tenantId: input.tenantId,
      bootstrapTokenHash: input.bootstrapTokenHash,
      expectedHost: input.expectedHost,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('insertInstallation returned no row');
  return row;
}

export async function findInstallationByBootstrapHash(
  db: PlatformExecutor,
  hash: string,
): Promise<InstallationRow | null> {
  const rows = await db
    .select()
    .from(installations)
    .where(eq(installations.bootstrapTokenHash, hash))
    .limit(1);
  return rows[0] ?? null;
}

export async function findInstallationByInstanceHash(
  db: PlatformExecutor,
  hash: string,
): Promise<InstallationRow | null> {
  const rows = await db
    .select()
    .from(installations)
    .where(eq(installations.instanceTokenHash, hash))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Burns the bootstrap token and issues the per-instance one, in a single conditional update. The
 * `where` still carries the bootstrap hash, so two boxes racing the same one-time token cannot
 * both register: the second update matches zero rows.
 */
export async function completeRegistration(
  db: PlatformExecutor,
  input: {
    bootstrapTokenHash: string;
    instanceTokenHash: string;
    version: string;
    /** Where the instance says it lives. Host-checked against `expected_host` before we get here. */
    baseUrl: string;
    dashboardUrl: string | null;
    storefrontUrl: string | null;
  },
): Promise<InstallationRow | null> {
  const rows = await db
    .update(installations)
    .set({
      bootstrapTokenHash: null,
      instanceTokenHash: input.instanceTokenHash,
      version: input.version,
      baseUrl: input.baseUrl,
      dashboardUrl: input.dashboardUrl,
      storefrontUrl: input.storefrontUrl,
      registeredAt: new Date(),
      lastSeenAt: new Date(),
    })
    .where(eq(installations.bootstrapTokenHash, input.bootstrapTokenHash))
    .returning();
  return rows[0] ?? null;
}

/** The heartbeat (CE6). Version skew is invisible until you can query it; this is the query. */
export async function recordHeartbeat(
  db: PlatformExecutor,
  input: {
    id: string;
    version: string;
    licenceId: string | null;
    productCount: number;
    orderCount: number;
  },
): Promise<InstallationRow | null> {
  const rows = await db
    .update(installations)
    .set({
      version: input.version,
      licenceId: input.licenceId,
      productCount: input.productCount,
      orderCount: input.orderCount,
      lastSeenAt: new Date(),
    })
    .where(eq(installations.id, input.id))
    .returning();
  return rows[0] ?? null;
}

/** Registered instances, newest first. Unregistered ones are a handed-out token, not a box. */
export async function listRegisteredInstallations(
  db: PlatformExecutor,
): Promise<InstallationRow[]> {
  return db
    .select()
    .from(installations)
    .where(isNotNull(installations.registeredAt))
    .orderBy(desc(installations.createdAt));
}

/** By id. Deprovisioning needs the row it is about to undo (CK1). */
export async function findInstallationById(
  db: PlatformExecutor,
  id: string,
): Promise<InstallationRow | null> {
  const rows = await db.select().from(installations).where(eq(installations.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * The Logto application minted for this instance at registration. Recorded separately from
 * `completeRegistration` because it is the issuer's id, not ours, and the registration must still
 * succeed if identity is not wired up at all.
 */
export async function setLogtoApplication(
  db: PlatformExecutor,
  input: { id: string; logtoApplicationId: string | null },
): Promise<void> {
  await db
    .update(installations)
    .set({ logtoApplicationId: input.logtoApplicationId })
    .where(eq(installations.id, input.id));
}

/**
 * Deprovisioning (CK1). The row goes; the caller removes the redirect URIs and the instance's own
 * Logto application first, because an orphaned application is a redirect URI list that grows for
 * ever and a client secret nobody will ever revoke.
 */
export async function deleteInstallation(db: PlatformExecutor, id: string): Promise<boolean> {
  const rows = await db.delete(installations).where(eq(installations.id, id)).returning();
  return rows.length > 0;
}
