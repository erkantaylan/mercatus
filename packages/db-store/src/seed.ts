/**
 * Two pooled tenants, always (BUILD-PLAN §5.4, BL1).
 *
 * The second tenant is not decoration: every fixture needs somewhere to leak INTO, or the leak
 * suite is asserting against an empty database and passes for the wrong reason. `acme` and `borg`
 * exist so that "returns only acme's rows" is a claim with a counterexample available.
 *
 * Tenant ids are fixed uuids rather than random, so a diary entry, a curl and a psql session can
 * all name the same tenant tomorrow. In the real flow these come from the control plane (BV1).
 *
 * Runs as the OWNER. Every insert except `tenants` goes through a tenant-scoped transaction,
 * because `force row level security` binds the owner too -- the seed exercises the same mechanism
 * the application does.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createStoreDb } from './client.js';
import { ensureOrderCounter } from './repositories/orders.js';
import { insertProduct } from './repositories/products.js';
import { mirrorTenant } from './repositories/tenants.js';
import { withExplicitTenantTx } from './tenant-tx.js';

export const SEED_TENANTS = {
  acme: {
    id: '3f6b0b8a-1f4a-4d2a-9c3e-0a1b2c3d4e01',
    slug: 'acme',
    name: 'Acme Supply',
    branding: { accent: '#2f6f4f', bg: '#ffffff', fg: '#14261c' },
  },
  borg: {
    id: '3f6b0b8a-1f4a-4d2a-9c3e-0a1b2c3d4e02',
    slug: 'borg',
    name: 'Borg Outfitters',
    branding: { accent: '#3a4a8f', bg: '#ffffff', fg: '#1a1e33' },
  },
} as const;

const PRODUCTS = {
  acme: [
    { sku: 'ACM-001', title: 'Anvil, 50kg', priceMinor: 249900, stock: 12 },
    { sku: 'ACM-002', title: 'Rocket Skates', priceMinor: 89900, stock: 5 },
    { sku: 'ACM-003', title: 'Portable Hole', priceMinor: 44900, stock: 30 },
    { sku: 'ACM-004', title: 'Giant Rubber Band', priceMinor: 12900, stock: 100 },
  ],
  borg: [
    { sku: 'BRG-001', title: 'Assimilation Jacket', priceMinor: 159900, stock: 8 },
    { sku: 'BRG-002', title: 'Regeneration Alcove', priceMinor: 999900, stock: 2 },
    { sku: 'BRG-003', title: 'Ocular Implant', priceMinor: 74900, stock: 20 },
  ],
} as const;

export async function seed(adminUrl: string): Promise<void> {
  const { db, close } = createStoreDb(adminUrl, { max: 2 });
  try {
    for (const tenant of Object.values(SEED_TENANTS)) {
      // tenants has no RLS, but the counter row does -- so the mirror runs tenant-scoped too.
      await withExplicitTenantTx(db, tenant.id, async (tx) => {
        await mirrorTenant(tx, tenant);
        await ensureOrderCounter(tx, tenant.id);
      });

      const catalog = PRODUCTS[tenant.slug];
      await withExplicitTenantTx(db, tenant.id, async (tx) => {
        for (const product of catalog) {
          // Idempotent by (tenant_id, sku), the composite unique (BG1). No tenant predicate:
          // RLS already scopes this transaction, so matching on sku alone is matching within
          // this tenant (§3.5).
          const existing = await tx.query.products.findFirst({
            where: (p, { eq }) => eq(p.sku, product.sku),
          });
          if (existing) continue;
          await insertProduct(tx, tenant.id, { ...product, imageUrl: null });
        }
      });

      process.stdout.write(`  seeded ${tenant.slug} (${String(catalog.length)} products)\n`);
    }
  } finally {
    await close();
  }
}

/** `tsx src/seed.ts` runs it; `await import('./seed.js')` from migrate.ts does not. */
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
  const adminUrl = process.env['DATABASE_ADMIN_URL'];
  if (!adminUrl) throw new Error('DATABASE_ADMIN_URL is not set (BUILD-PLAN §8.2).');
  await seed(adminUrl);
}
