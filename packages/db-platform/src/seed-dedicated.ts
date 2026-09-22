/**
 * The dedicated tenants, and the installation records AppHost B registers against.
 *
 * This is deliberately SEPARATE from `seed.ts`, which seeds the two pooled tenants and says, in
 * its own header, that a dedicated tenant is not seeded because provisioning is a real, tested
 * operation (CK1). That is still true of the PRODUCT: `POST /installations` is how an operator
 * hands out a bootstrap token, and task 10 exercises it. What this file does is make the DEV LOOP
 * startable without a human in it -- AppHost B needs a token to present before anything is
 * running that could have issued one, and a chicken-and-egg at `aspire run` time is not a design
 * decision.
 *
 * It goes through the same rows and the same hashing as the route does. Nothing here is a
 * shortcut past the mechanism; it is the mechanism with a fixed input:
 *
 *   - the bootstrap token is stored ONLY as a sha256 hash, exactly as `POST /installations` does
 *   - it is unspent, so `POST /installations/register` burns it on first use like any other
 *   - the tenant is `dedicated`, which is the tier check `POST /installations` enforces
 *
 * The tokens are fixed development literals. They are printed on every run, they only ever exist
 * in an `aspire run` on a laptop, and they are worthless against anything that is not this
 * topology -- an instance token is per-instance and individually revocable (CE1).
 *
 * TWO OF THEM, NOT ONE (v2.0.0 repair round 1). `aspire stop` on AppHost A destroys A's Postgres,
 * so every control-plane rebuild forgets every installation. zenith recovered by itself because
 * its token was re-seeded here; orion, created by four curls at run time, did not -- so the
 * second dedicated tenant had to be re-created by hand after every rebuild, with a stale
 * `.instance/orion.json` on disk pointing at an installation that no longer existed. Seeding both
 * makes the four-tenant topology restartable, which is the difference between a demo and a loop.
 * A THIRD dedicated tenant is still the four curls: this list is the dev loop, not the product.
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

export interface SeedDedicatedTenant {
  readonly tenantId: string;
  readonly installationId: string;
  readonly slug: string;
  readonly name: string;
  /** Over the contract's `min(32)`. A development literal, never a credential. */
  readonly bootstrapToken: string;
  /**
   * HOST PINNING (GK, S1). The token may only ever be spent for URLs on this host.
   *
   * A HOSTNAME OF THE INSTANCE'S OWN, since repair round 1. It used to be `localhost`, because
   * AppHost B built its public URLs from Aspire `EndpointReference`s and Aspire renders every
   * endpoint host as `localhost` -- which put every dedicated box, and the pooled one, in ONE
   * cookie jar (cookies are scoped by host and ignore the port; lessons/17). Now AppHost B
   * publishes `<slug>.localtest.me:<aspire port>`, which resolves to loopback with no /etc/hosts
   * entry, and the pin follows it. The PORT is not pinned and must not be -- Aspire assigns it,
   * which is the whole of v2.0.0.
   */
  readonly expectedHost: string;
}

/**
 * Every dedicated tenant the dev loop can start without a human.
 *
 * `zenith` is the default `MERCATUS_TENANT_SLUG`; `orion` is what
 * `aspire/scripts/run-dedicated.sh orion` serves, and the second box the acceptance list asks for.
 */
export const SEED_DEDICATED_TENANTS: readonly SeedDedicatedTenant[] = [
  {
    tenantId: '3f6b0b8a-1f4a-4d2a-9c3e-0a1b2c3d4e03',
    installationId: '3f6b0b8a-1f4a-4d2a-9c3e-0a1b2c3d4e20',
    slug: 'zenith',
    name: 'Zenith Tools',
    bootstrapToken: 'mercatus-dev-bootstrap-token-for-zenith-001',
    expectedHost: 'zenith.localtest.me',
  },
  {
    tenantId: '3f6b0b8a-1f4a-4d2a-9c3e-0a1b2c3d4e04',
    installationId: '3f6b0b8a-1f4a-4d2a-9c3e-0a1b2c3d4e21',
    slug: 'orion',
    name: 'Orion Instruments',
    bootstrapToken: 'mercatus-dev-bootstrap-token-for-orion-001',
    expectedHost: 'orion.localtest.me',
  },
];

/** The first one, for callers that only ever meant zenith. */
export const SEED_DEDICATED: SeedDedicatedTenant = SEED_DEDICATED_TENANTS[0] as SeedDedicatedTenant;

function oneYearOut(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

export async function seedDedicated(adminUrl: string): Promise<void> {
  const { db, close } = createPlatformDb(adminUrl, { max: 2 });
  try {
    for (const seed of SEED_DEDICATED_TENANTS) {
      await db.transaction(async (tx) => {
        await tx
          .insert(users)
          .values({ id: SEED_USER.id, phone: SEED_USER.phone, name: SEED_USER.name })
          .onConflictDoNothing();

        await tx
          .insert(tenants)
          .values({
            id: seed.tenantId,
            slug: seed.slug,
            name: seed.name,
            // Active, because the demo is "their shop keeps selling when ours is down", and a
            // pending tenant has nothing to keep selling.
            status: 'active',
            tier: 'dedicated',
            activatedAt: new Date(),
          })
          .onConflictDoNothing();

        await tx
          .insert(memberships)
          .values({ userId: SEED_USER.id, tenantId: seed.tenantId, role: 'owner' })
          .onConflictDoNothing();

        await tx
          .insert(licences)
          .values({ tenantId: seed.tenantId, entitlements: {}, validUntil: oneYearOut() })
          .onConflictDoNothing();

        // Re-seeding must not hand out a SECOND unspent token for the same box, and must not
        // resurrect one that AppHost B has already burned. One row, keyed by a fixed id, and its
        // bootstrap hash is only written while it has never been registered.
        const existing = await tx
          .select()
          .from(installations)
          .where(eq(installations.id, seed.installationId))
          .limit(1);

        const row = existing[0];
        if (!row) {
          await tx.insert(installations).values({
            id: seed.installationId,
            tenantId: seed.tenantId,
            bootstrapTokenHash: hashToken(seed.bootstrapToken),
            expectedHost: seed.expectedHost,
          });
          process.stdout.write(`  seeded ${seed.slug} (active, dedicated) + unspent installation\n`);
        } else if (row.registeredAt) {
          process.stdout.write(
            `  ${seed.slug}: installation already registered, bootstrap token stays spent\n`,
          );
        } else {
          process.stdout.write(
            `  ${seed.slug}: installation already waiting, bootstrap token unchanged\n`,
          );
        }
      });

      process.stdout.write(
        `  bootstrap token: ${seed.bootstrapToken} (host-pinned to ${seed.expectedHost})\n`,
      );
    }
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
