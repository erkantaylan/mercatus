/**
 * The install command (architecture.md §7, CE1, CE4, CE7, CK2).
 *
 * This is what an operator runs ON THEIR OWN SERVER once, before the store starts. It is the
 * whole of "provisioning a dedicated instance", and every arrow in it is outbound:
 *
 *   1. present the one-time bootstrap token to `POST /installations/register`
 *   2. write the per-instance credential we were given to disk, 0600
 *   3. mirror the tenant the control plane named into THIS box's database
 *   4. (dev loop only) put a catalog in it, so the storefront has something to sell
 *
 * Nothing here reaches into their network, and nothing here is a shared secret: the bootstrap
 * token is spent on first use and the instance token is individually revocable. There is no push
 * path anywhere in it, which is the property that is expensive to undo later (CE7).
 *
 * It is idempotent and resumable (CK2): with a credential file already present it skips straight
 * to the mirror, because a bootstrap token can only ever be spent once and a re-run must not
 * brick a box. The tenant id comes from the control plane and is never invented here (BV1).
 *
 * Run: `pnpm --filter @mercatus/store provision`
 */
import { registerInstallationResultSchema } from '@mercatus/contracts';
import {
  createStoreDb,
  ensureOrderCounter,
  insertProduct,
  mirrorTenant,
  withExplicitTenantTx,
} from '@mercatus/db-store';

import { readVersion } from './deps.js';
import type { InstanceCredential } from './instance.js';
import { readInstanceCredential, writeInstanceCredential } from './instance.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set (BUILD-PLAN §8.2).`);
  return value;
}

/**
 * A development catalog, written only when `DEV_SEED_CATALOG=1`. The real answer is that the
 * merchant adds products in their dashboard; this exists so `aspire run` produces a shop with
 * something in it, exactly as the pooled seed does, and it is gated so that a published topology
 * can never invent stock.
 */
const DEV_CATALOG = [
  { sku: 'ZEN-001', title: 'Summit Backpack 40L', priceMinor: 289900, stock: 9 },
  { sku: 'ZEN-002', title: 'Titanium Trowel', priceMinor: 44900, stock: 25 },
  { sku: 'ZEN-003', title: 'Altimeter Watch', priceMinor: 749900, stock: 4 },
  { sku: 'ZEN-004', title: 'Storm Lantern', priceMinor: 99900, stock: 40 },
] as const;

const DEV_BRANDING = { accent: '#b4531a', bg: '#fffaf5', fg: '#2a1a10' } as const;

async function register(platformUrl: string, bootstrapToken: string): Promise<InstanceCredential> {
  const response = await fetch(`${platformUrl}/installations/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ bootstrapToken, version: readVersion() }),
  });
  if (!response.ok) {
    // One generic answer is all the control plane gives (S1), so say what we know: which URL,
    // which status. The bootstrap token itself never appears in a log line.
    throw new Error(
      `registration refused: ${String(response.status)} from ${platformUrl}/installations/register`,
    );
  }
  const result = registerInstallationResultSchema.parse(await response.json());
  return { ...result, registeredAt: new Date().toISOString() };
}

export async function provision(): Promise<void> {
  const platformUrl = required('PLATFORM_URL').replace(/\/+$/, '');
  const credentialPath = required('INSTANCE_TOKEN_PATH');
  const adminUrl = required('DATABASE_ADMIN_URL');
  const tenantSlug = required('TENANT_SLUG');

  const existing = readInstanceCredential(credentialPath);
  const credential = existing ?? (await register(platformUrl, required('INSTANCE_BOOTSTRAP_TOKEN')));
  if (existing) {
    process.stdout.write(
      `  already registered as installation ${credential.installationId}; bootstrap token stays spent\n`,
    );
  } else {
    writeInstanceCredential(credentialPath, credential);
    process.stdout.write(
      `  registered installation ${credential.installationId} for ${credential.tenantSlug}\n`,
    );
  }

  if (credential.tenantSlug !== tenantSlug) {
    throw new Error(
      `the control plane says this installation serves ${credential.tenantSlug}, ` +
        `but TENANT_SLUG is ${tenantSlug}`,
    );
  }

  // The tenant row is the control plane's, mirrored (BV1): its id is the one the heartbeat
  // reports and the one RLS scopes every row in this database to. N=1 and the same schema and
  // the same policies as pooled (CC2).
  const name = process.env['TENANT_NAME'] ?? credential.tenantSlug;
  const seedCatalog = process.env['DEV_SEED_CATALOG'] === '1';
  const { db, close } = createStoreDb(adminUrl, { max: 2 });
  try {
    await withExplicitTenantTx(db, credential.tenantId, async (tx) => {
      await mirrorTenant(tx, {
        id: credential.tenantId,
        slug: credential.tenantSlug,
        name,
        ...(seedCatalog ? { branding: DEV_BRANDING } : {}),
      });
      await ensureOrderCounter(tx, credential.tenantId);
    });
    process.stdout.write(`  mirrored tenant ${credential.tenantSlug} (${credential.tenantId})\n`);

    if (seedCatalog) {
      let written = 0;
      await withExplicitTenantTx(db, credential.tenantId, async (tx) => {
        for (const product of DEV_CATALOG) {
          // Idempotent by (tenant_id, sku) (BG1). No tenant predicate: the transaction is already
          // scoped by RLS, so matching on sku alone is matching within this tenant (§3.5).
          const existing = await tx.query.products.findFirst({
            where: (p, { eq }) => eq(p.sku, product.sku),
          });
          if (existing) continue;
          await insertProduct(tx, credential.tenantId, { ...product, imageUrl: null });
          written += 1;
        }
      });
      process.stdout.write(`  dev catalog: ${String(written)} product(s) written\n`);
    }
  } finally {
    await close();
  }
}

await provision();
