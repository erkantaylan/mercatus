/**
 * The control-plane seed (BUILD-PLAN §5.4).
 *
 * Two pooled tenants matching db-store's, one user who owns both, and an active licence each.
 * The tenant uuids are the SAME literals as db-store's SEED_TENANTS: the data plane mirrors
 * control-plane ids (BV1), so if these two lists ever disagree, every mirrored row points at a
 * tenant that does not exist. They are duplicated rather than imported because db-platform must
 * not depend on db-store -- that dependency is the control-plane/data-plane boundary (CO3) -- and
 * a test asserts they match.
 *
 * `zenith`, the dedicated tenant, is NOT seeded. It is created by the buy-a-store flow or by
 * POST /installations, because provisioning being a real, tested operation is the point (CK1).
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createPlatformDb } from './client.js';
import { licences, memberships, tenants, users } from './schema.js';

export const SEED_TENANT_IDS = {
  acme: '3f6b0b8a-1f4a-4d2a-9c3e-0a1b2c3d4e01',
  borg: '3f6b0b8a-1f4a-4d2a-9c3e-0a1b2c3d4e02',
} as const;

export const SEED_USER = {
  id: '3f6b0b8a-1f4a-4d2a-9c3e-0a1b2c3d4e10',
  phone: '+905550000000',
  name: 'Dev Owner',
} as const;

function oneYearOut(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

export async function seed(adminUrl: string): Promise<void> {
  const { db, close } = createPlatformDb(adminUrl, { max: 2 });
  try {
    await db.transaction(async (tx) => {
      await tx
        .insert(users)
        .values({ id: SEED_USER.id, phone: SEED_USER.phone, name: SEED_USER.name })
        .onConflictDoNothing();

      const rows = [
        { id: SEED_TENANT_IDS.acme, slug: 'acme', name: 'Acme Supply' },
        { id: SEED_TENANT_IDS.borg, slug: 'borg', name: 'Borg Outfitters' },
      ] as const;

      const validUntil = oneYearOut();
      for (const row of rows) {
        await tx
          .insert(tenants)
          .values({
            id: row.id,
            slug: row.slug,
            name: row.name,
            status: 'active',
            tier: 'pooled',
            activatedAt: new Date(),
          })
          .onConflictDoNothing();

        await tx
          .insert(memberships)
          .values({ userId: SEED_USER.id, tenantId: row.id, role: 'owner' })
          .onConflictDoNothing();

        await tx
          .insert(licences)
          .values({ tenantId: row.id, entitlements: {}, validUntil })
          .onConflictDoNothing();

        process.stdout.write(`  seeded ${row.slug} (active, pooled, licence to ${validUntil})\n`);
      }
    });
  } finally {
    await close();
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  // The dev-seed step seeds two databases from one process, so the control plane's owner URL
  // has its own variable -- the same reason the platform test suite reads PLATFORM_DATABASE_URL.
  const adminUrl = process.env['PLATFORM_DATABASE_ADMIN_URL'] ?? process.env['DATABASE_ADMIN_URL'];
  if (!adminUrl) throw new Error('PLATFORM_DATABASE_ADMIN_URL is not set (BUILD-PLAN §8.2).');
  await seed(adminUrl);
}
