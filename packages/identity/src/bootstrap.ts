/**
 * Provisions a fresh Logto instance so that nothing in this repo needs a human in a browser.
 *
 * What it creates, and why each one is here:
 *
 *   organization scopes / roles   `owner` and `staff`. Organizations ARE tenants, and membership
 *                                 of one is what makes somebody merchant staff (CD3).
 *   organizations                 one per tenant, NAMED with our slug. A Logto organization id is
 *                                 generated and is NOT our tenant id (BV1) -- the name carries the
 *                                 slug, and the data plane already knows how to resolve a slug.
 *   applications                  one per surface, with its redirect URIs. The store is a
 *                                 confidential client because it exchanges the code server-side
 *                                 and then issues its OWN session cookie.
 *   users                         staff, WITH organization membership and a role; and a shopper,
 *                                 with NO organization at all. That absence is the rule (CD3).
 *
 * Idempotent (CK2): every step looks for what it would create first, so a second run against the
 * same instance changes nothing and a half-finished first run resumes.
 *
 * Finally it writes the data plane's identity cache -- client registration, discovery document,
 * key set and the organization directory -- so a store can verify an organization token offline
 * from its very first request rather than only after somebody has signed in (CG1).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { LogtoManagementClient, readManagementSecret } from './logto.js';

interface Named {
  id: string;
  name: string;
}

interface ApplicationSpec {
  /** Stable name; it is how a re-run finds what it already made. */
  readonly name: string;
  readonly type: 'Traditional' | 'SPA';
  readonly redirectUris: readonly string[];
  readonly postLogoutRedirectUris?: readonly string[];
  /** Key in the output file, and in the identity cache when it is a store. */
  readonly key: string;
}

const ROLES = [
  { name: 'owner', description: 'Owns the store', scopes: ['store:manage', 'store:read'] },
  { name: 'staff', description: 'Works in the store', scopes: ['store:read'] },
] as const;

const SCOPES = [
  { name: 'store:manage', description: 'Change products, settings and orders' },
  { name: 'store:read', description: 'Read the store' },
] as const;

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function say(line: string): void {
  process.stdout.write(`identity: ${line}\n`);
}

async function findOrCreate<T extends Named>(
  client: LogtoManagementClient,
  collection: string,
  name: string,
  body: Record<string, unknown>,
): Promise<T> {
  const existing = await client.get<T[]>(collection);
  const match = existing.find((entry) => entry.name === name);
  if (match) return match;
  return client.post<T>(collection, { ...body, name });
}

/** Logto answers 409/422 when a relation is already there; that is success, not a failure. */
async function relate(client: LogtoManagementClient, path: string, body: unknown): Promise<void> {
  try {
    await client.post(path, body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/-> 4\d\d/.test(message)) throw error;
  }
}

async function main(): Promise<void> {
  const endpoint = env('LOGTO_ENDPOINT', 'http://127.0.0.1:3011').replace(/\/$/, '');
  const adminEndpoint = env('LOGTO_ADMIN_ENDPOINT', 'http://127.0.0.1:3012').replace(/\/$/, '');
  const databaseUrl = process.env['LOGTO_DB_URL'];
  const devPassword = env('IDENTITY_DEV_PASSWORD', 'Mercatus-dev-1');
  const slugs = env('IDENTITY_TENANT_SLUGS', 'acme,borg,zenith')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const storePooledUrl = env('STORE_POOLED_URL', 'http://127.0.0.1:4002');
  const storeDedicatedUrl = env('STORE_DEDICATED_URL', 'http://127.0.0.1:4003');
  const dashboardUrl = env('DASHBOARD_URL', 'http://127.0.0.1:5173');
  const dashboardDedicatedUrl = env('DASHBOARD_DEDICATED_URL', 'http://127.0.0.1:5175');
  const adminUrl = env('ADMIN_URL', 'http://127.0.0.1:5174');
  const storefrontUrl = env('STOREFRONT_URL', 'http://127.0.0.1:3001');
  const storefrontDedicatedUrl = env('STOREFRONT_DEDICATED_URL', 'http://127.0.0.1:3002');

  const applications: readonly ApplicationSpec[] = [
    {
      key: 'store-pooled',
      name: 'Mercatus store (pooled)',
      type: 'Traditional',
      redirectUris: [`${storePooledUrl}/auth/callback`],
      postLogoutRedirectUris: [`${storefrontUrl}/`],
    },
    {
      key: 'store-dedicated',
      name: 'Mercatus store (dedicated)',
      type: 'Traditional',
      redirectUris: [`${storeDedicatedUrl}/auth/callback`],
      postLogoutRedirectUris: [`${storefrontDedicatedUrl}/`],
    },
    {
      key: 'dashboard',
      name: 'Mercatus dashboard',
      type: 'SPA',
      redirectUris: [`${dashboardUrl}/callback`, `${dashboardDedicatedUrl}/callback`],
      postLogoutRedirectUris: [`${dashboardUrl}/`],
    },
    {
      key: 'admin',
      name: 'Mercatus platform console',
      type: 'SPA',
      redirectUris: [`${adminUrl}/callback`],
      postLogoutRedirectUris: [`${adminUrl}/`],
    },
    {
      key: 'storefront',
      name: 'Mercatus storefront',
      type: 'Traditional',
      redirectUris: [
        `${storefrontUrl}/api/auth/callback`,
        `${storefrontDedicatedUrl}/api/auth/callback`,
      ],
      postLogoutRedirectUris: [`${storefrontUrl}/`],
    },
  ];

  const clientSecret =
    process.env['LOGTO_M2M_SECRET'] ??
    (databaseUrl ? await readManagementSecret(databaseUrl) : undefined);
  if (!clientSecret) {
    throw new Error('Set LOGTO_DB_URL (preferred) or LOGTO_M2M_SECRET so the bootstrap can authenticate.');
  }

  const client = new LogtoManagementClient({
    endpoint,
    adminEndpoint,
    clientId: env('LOGTO_M2M_APP_ID', 'm-default'),
    clientSecret,
  });

  await client.waitUntilReady(Number(env('IDENTITY_READY_TIMEOUT_MS', '120000')));
  say(`logto is up at ${endpoint}`);

  // -- organization scopes and roles ------------------------------------------------------------
  const scopeIds = new Map<string, string>();
  for (const scope of SCOPES) {
    const created = await findOrCreate<Named>(client, '/organization-scopes', scope.name, {
      description: scope.description,
    });
    scopeIds.set(scope.name, created.id);
  }
  for (const role of ROLES) {
    const created = await findOrCreate<Named>(client, '/organization-roles', role.name, {
      description: role.description,
    });
    // `organizationScopeNames` on create is accepted and then ignored; the scopes have to be
    // attached through the relation endpoint. Verified against Logto 1.43.
    const wanted = role.scopes.map((s) => scopeIds.get(s)).filter((id): id is string => Boolean(id));
    await relate(client, `/organization-roles/${created.id}/scopes`, {
      organizationScopeIds: wanted,
    });
  }
  say(`${String(SCOPES.length)} scopes, ${String(ROLES.length)} roles`);

  // -- applications ------------------------------------------------------------------------------
  const registrations: Record<string, { clientId: string; clientSecret: string }> = {};
  for (const spec of applications) {
    const app = await findOrCreate<Named>(client, '/applications', spec.name, {
      type: spec.type,
      oidcClientMetadata: {
        redirectUris: [...spec.redirectUris],
        postLogoutRedirectUris: [...(spec.postLogoutRedirectUris ?? [])],
      },
    });
    // The usable secret is NEVER the `secret` column for an app made through the API -- that
    // holds a "#internal:" placeholder. It is here.
    const secrets = await client.get<{ value: string }[]>(`/applications/${app.id}/secrets`);
    registrations[spec.key] = { clientId: app.id, clientSecret: secrets[0]?.value ?? '' };
  }
  say(`${String(applications.length)} applications`);

  // -- organizations = tenants --------------------------------------------------------------------
  const organizations: Record<string, { slug: string }> = {};
  const organizationBySlug = new Map<string, string>();
  for (const slug of slugs) {
    const organization = await findOrCreate<Named>(client, '/organizations', slug, {
      description: `Mercatus tenant ${slug}`,
      // Our own id is deliberately NOT here: Logto generates the organization id and a tenant id
      // is minted by the control plane (BV1). The slug is the join, and it is the name.
      customData: { slug },
    });
    organizations[organization.id] = { slug };
    organizationBySlug.set(slug, organization.id);
  }
  say(`${String(slugs.length)} organizations: ${slugs.join(', ')}`);

  // -- users ---------------------------------------------------------------------------------------
  const everyone = await client.get<{ id: string; username: string | null }[]>('/users?page=1&page_size=100');
  const byUsername = new Map(everyone.filter((u) => u.username).map((u) => [u.username, u.id]));

  const ensureUser = async (username: string, name: string): Promise<string> => {
    const existing = byUsername.get(username);
    if (existing) return existing;
    const created = await client.post<{ id: string }>('/users', {
      username,
      password: devPassword,
      name,
    });
    byUsername.set(username, created.id);
    return created.id;
  };

  const staff: Record<string, { username: string; userId: string; slug: string }> = {};
  for (const slug of slugs) {
    // Logto validates usernames against /^[A-Z_a-z]\w*$/ -- a dot or a hyphen is a 400.
    const username = `${slug.replace(/-/g, '_')}_owner`;
    const userId = await ensureUser(username, `${slug} owner`);
    const organizationId = organizationBySlug.get(slug);
    if (!organizationId) continue;
    await relate(client, `/organizations/${organizationId}/users`, { userIds: [userId] });
    await relate(client, `/organizations/${organizationId}/users/${userId}/roles`, {
      organizationRoleNames: ['owner'],
    });
    staff[slug] = { username, userId, slug };
  }

  // CD3: a shopper is a plain user with NO organization membership. The absence is the whole
  // distinction -- it is what makes a tenant-scoped token impossible for them to hold.
  const shopperUsername = env('IDENTITY_SHOPPER_USERNAME', 'shopper');
  const shopperId = await ensureUser(shopperUsername, 'Dev shopper');
  say(`${String(slugs.length)} staff users, 1 shopper (${shopperUsername}), password ${devPassword}`);

  // -- the data plane's identity cache -------------------------------------------------------------
  const discovery = (await (
    await fetch(`${endpoint}/oidc/.well-known/openid-configuration`)
  ).json()) as { jwks_uri: string };
  const jwks = await (await fetch(discovery.jwks_uri)).json();

  const cacheFor = (key: string): unknown => ({
    client: registrations[key],
    discovery,
    jwks,
    organizations,
  });

  const caches: [string | undefined, string][] = [
    [process.env['IDENTITY_CACHE_PATH'], 'store-pooled'],
    [process.env['IDENTITY_CACHE_PATH_DEDICATED'], 'store-dedicated'],
  ];
  for (const [path, key] of caches) {
    if (!path) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cacheFor(key), null, 2), 'utf8');
    // ABSOLUTE, because `pnpm --filter <pkg> bootstrap` runs with cwd = the PACKAGE directory,
    // not the repo root, and a relative path in the log is then quietly wrong.
    say(`wrote identity cache for ${key} -> ${resolve(path)}`);
  }

  const outPath = process.env['IDENTITY_OUT'];
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          endpoint,
          issuer: `${endpoint}/oidc`,
          applications: registrations,
          organizations,
          staff,
          shopper: { username: shopperUsername, userId: shopperId },
          devPassword,
        },
        null,
        2,
      ),
      'utf8',
    );
    say(`wrote ${resolve(outPath)}`);
  }

  say('done');
}

await main();
