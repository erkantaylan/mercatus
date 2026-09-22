/**
 * The install command (architecture.md §7, CE1, CE4, CE7, CK2).
 *
 * This is what an operator runs ON THEIR OWN SERVER once, before the store starts. It is the
 * whole of "provisioning a dedicated instance", and every arrow in it is outbound:
 *
 *   1. present the one-time bootstrap token to `POST /installations/register`, SAYING WHERE
 *      THIS BOX LIVES
 *   2. write the per-instance credential we were given to disk, 0600
 *   3. write the identity cache from the issuer client that came back with it
 *   4. mirror the tenant the control plane named into THIS box's database
 *   5. (dev loop only) put a catalog in it, so the storefront has something to sell
 *
 * Step 1's second half is v2.0.0. Before it, the control plane had to be told this store's
 * address in advance -- which meant a fixed port agreed between two application models that are
 * otherwise forbidden to know about each other, and an OIDC client registered against a guess.
 * Now this process reports its own `baseUrl` (host-pinned at the other end, GK) and is handed
 * back `{issuer, clientId, clientSecret}`: configured BY THE ANSWER, not by environment.
 *
 * Step 3 has to happen HERE, in this process, and not in the store. The store's OIDC adapter
 * reads its cache file ONCE, in its constructor, and never again -- so the file has to be on
 * disk before the store starts, and this task is the thing AppHost B makes the store wait for.
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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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

/**
 * Where this box will actually answer. `STORE_PUBLIC_URL` is the store's own endpoint, handed to
 * this task by the orchestrator that assigned it, so the URL the control plane registers as a
 * redirect target is by construction the URL the store will later send as its `redirect_uri`.
 *
 * The SPELLING is load-bearing, not just the port (lessons/14): Logto matches a redirect_uri as a
 * string, and `localhost` and `127.0.0.1` are the same socket and two different URIs. Taking the
 * address from the same place the store takes it is what makes them agree.
 */
function reportedUrls(): { baseUrl: string; dashboardUrl?: string; storefrontUrl?: string } {
  const trim = (u: string): string => u.replace(/\/+$/, '');
  const optional = (name: string): string | undefined => {
    const value = process.env[name];
    return value === undefined || value === '' ? undefined : trim(value);
  };
  return {
    baseUrl: trim(required('STORE_PUBLIC_URL')),
    ...(optional('DASHBOARD_PUBLIC_URL') === undefined
      ? {}
      : { dashboardUrl: optional('DASHBOARD_PUBLIC_URL') }),
    ...(optional('STOREFRONT_PUBLIC_URL') === undefined
      ? {}
      : { storefrontUrl: optional('STOREFRONT_PUBLIC_URL') }),
  };
}

async function register(platformUrl: string, bootstrapToken: string): Promise<InstanceCredential> {
  const urls = reportedUrls();
  process.stdout.write(`  registering at ${urls.baseUrl}\n`);
  const response = await fetch(`${platformUrl}/installations/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ bootstrapToken, version: readVersion(), ...urls }),
  });
  if (!response.ok) {
    // One generic answer is all the control plane gives (S1), so say what we know: which URL,
    // which status. The bootstrap token itself never appears in a log line.
    throw new Error(
      `registration refused: ${String(response.status)} from ${platformUrl}/installations/register ` +
        `(reported baseUrl ${urls.baseUrl}). ` +
        'A 401 is ONE answer for several causes (S1) and the control plane\'s log says which: ' +
        'the token is unknown or already spent, or this box reported a host the installation is ' +
        'not pinned to. A bootstrap token is spent on first use: if this control plane still ' +
        'holds this installation, the credential file is the one to keep; if its database was ' +
        're-built, re-seed it so the dev bootstrap token is unspent again.',
    );
  }
  const result = registerInstallationResultSchema.parse(await response.json());
  return { ...result, registeredAt: new Date().toISOString() };
}

/**
 * The identity cache the store's OIDC adapter reads in its constructor: this instance's client,
 * the discovery document, the key set, and the ONE organization that is this tenant.
 *
 * Everything in it is either the register answer or fetched straight from the issuer by this box.
 * Nothing is handed to us as a file by the control plane any more, and -- unlike the file that
 * used to be -- it carries no other tenant's organization id (CE1).
 *
 * Merged, never overwritten: the adapter writes its own learnings (which subject holds which role
 * in which organization) into the same file, and a re-provision must not throw those away.
 */
function writeIdentityCache(path: string, credential: InstanceCredential, issuerJwks: {
  discovery: unknown;
  jwks: unknown;
}): void {
  const oidc = credential.oidc;
  if (!oidc) return;
  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    // No cache yet, or a half-written one. Either way this run replaces it.
    existing = {};
  }
  const organizations = {
    ...((existing['organizations'] as Record<string, unknown> | undefined) ?? {}),
    ...(oidc.organizationId === null
      ? {}
      : { [oidc.organizationId]: { slug: credential.tenantSlug } }),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        ...existing,
        client: { clientId: oidc.clientId, clientSecret: oidc.clientSecret },
        discovery: issuerJwks.discovery,
        jwks: issuerJwks.jwks,
        organizations,
      },
      null,
      2,
    )}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  process.stdout.write(`  wrote the identity cache -> ${resolve(path)}\n`);
}

/**
 * The discovery document and the key set, pulled from the issuer BY THIS BOX (CE4). Failing to
 * reach it is not fatal: the adapter fetches both itself the first time it needs them, and a
 * store that refuses to start because the issuer was slow is the failure CG1 exists to prevent.
 */
async function fetchIssuerMetadata(
  issuer: string,
): Promise<{ discovery: unknown; jwks: unknown } | null> {
  try {
    const discovery = (await (
      await fetch(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(10_000),
      })
    ).json()) as { jwks_uri: string };
    const jwks = await (
      await fetch(discovery.jwks_uri, { signal: AbortSignal.timeout(10_000) })
    ).json();
    return { discovery, jwks };
  } catch (error) {
    process.stdout.write(
      `  could not read ${issuer} discovery (${error instanceof Error ? error.message : String(error)}); ` +
        'the store will fetch it on demand\n',
    );
    return null;
  }
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

  // The identity cache, from whatever the control plane last told us. Written on every run, not
  // only on a fresh registration: the file is the store's ONLY view of its own client, it is read
  // once in a constructor, and rebuilding it from a credential we already hold costs one fetch.
  const cachePath = process.env['IDENTITY_CACHE_PATH'];
  if (cachePath && credential.oidc) {
    const metadata = await fetchIssuerMetadata(credential.oidc.issuer);
    if (metadata) writeIdentityCache(cachePath, credential, metadata);
  } else if (cachePath) {
    process.stdout.write(
      `  the control plane returned no issuer client; leaving ${cachePath} as it is\n`,
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
