/**
 * The dedicated tenant, and the installation record AppHost B registers against.
 *
 * This is deliberately SEPARATE from `seed.ts`, which seeds the two pooled tenants and says, in
 * its own header, that zenith is not seeded because provisioning is a real, tested operation
 * (CK1). That is still true of the PRODUCT: `POST /installations` is how an operator hands out a
 * bootstrap token, and task 10 exercises it. What this file does is make the DEV LOOP startable
 * without a human in it -- AppHost B needs a token to present before anything is running that
 * could have issued one, and a chicken-and-egg at `aspire run` time is not a design decision.
 *
 * It goes through the same rows and the same hashing as the route does. Nothing here is a
 * shortcut past the mechanism; it is the mechanism with a fixed input:
 *
 *   - the bootstrap token is stored ONLY as a sha256 hash, exactly as `POST /installations` does
 *   - it is unspent, so `POST /installations/register` burns it on first use like any other
 *   - the tenant is `dedicated`, which is the tier check `POST /installations` enforces
 *
 * The token itself is a fixed development literal. It is printed on every run, it only ever
 * exists in an `aspire run` on a laptop, and it is worthless against anything that is not this
 * topology -- an instance token is per-instance and individually revocable (CE1).
 *
 * Ids are fixed uuids for the same reason the pooled seed's are: a diary entry, a curl and a
 * psql session should be able to name the same tenant tomorrow.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';

import { createPlatformDb } from './client.js';
import { hashToken } from './repositories/installations.js';
import { installations, licences, memberships, tenants, users } from './schema.js';
import { SEED_USER } from './seed.js';

export const SEED_DEDICATED = {
  tenantId: '3f6b0b8a-1f4a-4d2a-9c3e-0a1b2c3d4e03',
  installationId: '3f6b0b8a-1f4a-4d2a-9c3e-0a1b2c3d4e20',
  slug: 'zenith',
  name: 'Zenith Tools',
  /** 43 characters, over the contract's `min(32)`. A development literal, never a credential. */
  bootstrapToken: 'mercatus-dev-bootstrap-token-for-zenith-001',
} as const;

function oneYearOut(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

export async function seedDedicated(adminUrl: string): Promise<void> {
  const { db, close } = createPlatformDb(adminUrl, { max: 2 });
  try {
    await db.transaction(async (tx) => {
      await tx
        .insert(users)
        .values({ id: SEED_USER.id, phone: SEED_USER.phone, name: SEED_USER.name })
        .onConflictDoNothing();

      await tx
        .insert(tenants)
        .values({
          id: SEED_DEDICATED.tenantId,
          slug: SEED_DEDICATED.slug,
          name: SEED_DEDICATED.name,
          // Active, because the demo is "their shop keeps selling when ours is down", and a
          // pending tenant has nothing to keep selling.
          status: 'active',
          tier: 'dedicated',
          activatedAt: new Date(),
        })
        .onConflictDoNothing();

      await tx
        .insert(memberships)
        .values({ userId: SEED_USER.id, tenantId: SEED_DEDICATED.tenantId, role: 'owner' })
        .onConflictDoNothing();

      await tx
        .insert(licences)
        .values({ tenantId: SEED_DEDICATED.tenantId, entitlements: {}, validUntil: oneYearOut() })
        .onConflictDoNothing();

      // Re-seeding must not hand out a SECOND unspent token for the same box, and must not
      // resurrect one that AppHost B has already burned. One row, keyed by a fixed id, and its
      // bootstrap hash is only written while it has never been registered.
      const existing = await tx
        .select()
        .from(installations)
        .where(eq(installations.id, SEED_DEDICATED.installationId))
        .limit(1);

      const row = existing[0];
      if (!row) {
        await tx.insert(installations).values({
          id: SEED_DEDICATED.installationId,
          tenantId: SEED_DEDICATED.tenantId,
          bootstrapTokenHash: hashToken(SEED_DEDICATED.bootstrapToken),
        });
        process.stdout.write(
          `  seeded ${SEED_DEDICATED.slug} (active, dedicated) + unspent installation\n`,
        );
      } else if (row.registeredAt) {
        process.stdout.write(
          `  ${SEED_DEDICATED.slug}: installation already registered, bootstrap token stays spent\n`,
        );
      } else {
        process.stdout.write(
          `  ${SEED_DEDICATED.slug}: installation already waiting, bootstrap token unchanged\n`,
        );
      }
    });

    process.stdout.write(`  bootstrap token: ${SEED_DEDICATED.bootstrapToken}\n`);
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
  // One process seeds two databases in the dev-seed step, so the control plane's owner URL has
  // its own variable. Same reason the platform test suite reads PLATFORM_DATABASE_URL.
  const adminUrl = process.env['PLATFORM_DATABASE_ADMIN_URL'] ?? process.env['DATABASE_ADMIN_URL'];
  if (!adminUrl) throw new Error('PLATFORM_DATABASE_ADMIN_URL is not set (BUILD-PLAN §8.2).');
  await seedDedicated(adminUrl);
}
