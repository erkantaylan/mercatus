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
 * It is idempotent and resumable (CK2): with a credential file already present it CHECKS that
 * credential against the control plane before reusing it, and re-registers only if the control
 * plane says it has never heard of it. The tenant id comes from the control plane and is never
 * invented here (BV1).
 *
 * That check is not ceremony. Without it the second `aspire run` of AppHost B was silently
 * broken for ever: `aspire stop` on AppHost A destroys A's Postgres, so the installation record
 * is gone, while `.instance/zenith.json` survives on disk -- the box then polled with a token the
 * new control plane has never seen, got 401 on every tick, and (before the licence fix) reported
 * itself healthy while no heartbeat ever arrived. The README said B "never needs the bootstrap
 * token again", which was true only until the control plane's database was rebuilt.
 *
 * Unreachable is NOT rejected (CG1, CG3). A control plane that cannot be reached at all leaves
 * the credential alone and the store boots anyway; only an explicit refusal re-registers.
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
      `registration refused: ${String(response.status)} from ${platformUrl}/installations/register. ` +
        'A bootstrap token is spent on first use: if this control plane still holds this ' +
        "installation, the credential file is the one to keep; if its database was rebuilt, " +
        're-seed it so the dev bootstrap token is unspent again.',
    );
  }
  const result = registerInstallationResultSchema.parse(await response.json());
  return { ...result, registeredAt: new Date().toISOString() };
}

/**
 * Does the control plane still know this credential? `GET /tenants/:slug/licence` is the same
 * call the licence agent makes every few seconds, so a green answer here means the box is
 * genuinely provisioned rather than merely holding a file.
 */
async function credentialVerdict(
  platformUrl: string,
  credential: InstanceCredential,
): Promise<'ok' | 'rejected' | 'unreachable'> {
  let response: Response;
  try {
    response = await fetch(`${platformUrl}/tenants/${credential.tenantSlug}/licence`, {
      headers: { authorization: `Bearer ${credential.instanceToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return 'unreachable';
  }
  if (response.ok) return 'ok';
  // 401 unknown credential, 403 someone else's tenant, 404 a control plane that has never heard
  // of this tenant at all -- every one of them means this file is not a working credential.
  if ([401, 403, 404].includes(response.status)) return 'rejected';
  return 'unreachable';
}

export async function provision(): Promise<void> {
  const platformUrl = required('PLATFORM_URL').replace(/\/+$/, '');
  const credentialPath = required('INSTANCE_TOKEN_PATH');
  const adminUrl = required('DATABASE_ADMIN_URL');
  const tenantSlug = required('TENANT_SLUG');

  const existing = readInstanceCredential(credentialPath);
  let credential: InstanceCredential;
  if (existing) {
    const verdict = await credentialVerdict(platformUrl, existing);
    if (verdict === 'ok') {
      credential = existing;
      process.stdout.write(
        `  credential at ${credentialPath} accepted by ${platformUrl}: installation ${existing.installationId}\n`,
      );
    } else if (verdict === 'unreachable') {
      credential = existing;
      process.stdout.write(
        `  ${platformUrl} could not be reached; keeping the credential at ${credentialPath} ` +
          'and starting anyway (CG1)\n',
      );
    } else {
      // The control plane refused it. Its database was rebuilt, or this installation was
      // revoked. Spend the bootstrap token again rather than leaving a box that polls for ever
      // into a 401 -- and say so, because "re-registered" is an event an operator should see.
      process.stdout.write(
        `  ${platformUrl} REFUSED the credential at ${credentialPath} (installation ` +
          `${existing.installationId}). Re-registering.\n`,
      );
      credential = await register(platformUrl, required('INSTANCE_BOOTSTRAP_TOKEN'));
      writeInstanceCredential(credentialPath, credential);
      process.stdout.write(
        `  re-registered as installation ${credential.installationId} for ${credential.tenantSlug}\n`,
      );
    }
  } else {
    credential = await register(platformUrl, required('INSTANCE_BOOTSTRAP_TOKEN'));
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
