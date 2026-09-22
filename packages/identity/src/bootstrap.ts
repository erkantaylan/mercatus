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
 * Finally it writes the POOLED data plane's identity cache -- client registration, discovery
 * document, key set and the organization directory -- so a store can verify an organization token
 * offline from its very first request rather than only after somebody has signed in (CG1).
 *
 * It registers NOTHING for a dedicated instance. It used to: `STORE_DEDICATED_URL` named a box
 * that did not exist yet, at a port two application models had to agree on in advance, which is
 * the coupling v2.0.0 removes. A dedicated instance now registers ITSELF
 * (`POST /installations/register`), the control plane adds its redirect URIs through the same
 * Management API this file uses, and the answer carries the client it was given. The one thing
 * this task still owes that path is the M2M credential: `IDENTITY_MANAGEMENT_OUT`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { APPLICATION_NAMES } from './applications.js';
import { LogtoManagementClient } from './logto.js';
import { readManagementSecret } from './management-secret.js';

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

  // Every surface in AppHost A, and nothing from AppHost B: a dedicated instance's addresses are
  // Aspire-assigned in a model this one cannot see, and it registers them itself.
  const storePooledUrl = env('STORE_POOLED_URL', 'http://127.0.0.1:4002');
  const dashboardUrl = env('DASHBOARD_URL', 'http://127.0.0.1:5173');
  const adminUrl = env('ADMIN_URL', 'http://127.0.0.1:5174');
  const storefrontUrl = env('STOREFRONT_URL', 'http://127.0.0.1:3001');

  const applications: readonly ApplicationSpec[] = [
    {
      key: 'store-pooled',
      name: APPLICATION_NAMES.storePooled,
      type: 'Traditional',
      // ALL THREE PLACES A BROWSER CAN LAND, on the one client that does the exchange (v2.0.0).
      // The store is the only OIDC client in this topology: it is the only process that holds a
      // client secret, so the storefront's and the dashboard's callbacks are ITS redirect URIs,
      // not those of two clients neither front end could authenticate as. The dedicated plane's
      // equivalent is `callbacks()` in apps/platform/src/identity.ts.
      redirectUris: [
        `${storePooledUrl}/auth/callback`,
        `${storefrontUrl}/api/auth/callback`,
        `${dashboardUrl}/callback`,
      ],
      postLogoutRedirectUris: [`${storefrontUrl}/`],
    },
    {
      key: 'dashboard',
      name: APPLICATION_NAMES.dashboard,
      type: 'SPA',
      redirectUris: [`${dashboardUrl}/callback`],
      postLogoutRedirectUris: [`${dashboardUrl}/`],
    },
    {
      key: 'admin',
      name: APPLICATION_NAMES.admin,
      type: 'SPA',
      redirectUris: [`${adminUrl}/callback`],
      postLogoutRedirectUris: [`${adminUrl}/`],
    },
    {
      key: 'storefront',
      name: APPLICATION_NAMES.storefront,
      type: 'Traditional',
      redirectUris: [`${storefrontUrl}/api/auth/callback`],
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

  // The POOLED store's cache, and only it. A dedicated instance writes its own from what
  // `POST /installations/register` answered -- it is not handed a file by us any more, and it is
  // not handed the directory of every tenant we have either (CE1).
  const cachePath = process.env['IDENTITY_CACHE_PATH'];
  if (cachePath) {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cacheFor('store-pooled'), null, 2), 'utf8');
    // ABSOLUTE, because `pnpm --filter <pkg> bootstrap` runs with cwd = the PACKAGE directory,
    // not the repo root, and a relative path in the log is then quietly wrong.
    say(`wrote identity cache for store-pooled -> ${resolve(cachePath)}`);
  }

  // -- the Management API credential, for the control plane -----------------------------------
  // The awkward part of v2.0.0, made small. `apps/platform` has to call this same Management API
  // at RUNTIME now (an instance registers and says where it lives), and the M2M secret is random
  // per `logto db seed` and lives in Logto's own `applications` table. The platform must not read
  // that table -- it is a schema we do not own (CD2) -- so the credential is handed over here, by
  // the one task that is already allowed to read it, as a 0600 file the platform opens lazily.
  // Lazy on purpose: the platform must be listening long before Logto has finished seeding.
  const managementOut = process.env['IDENTITY_MANAGEMENT_OUT'];
  if (managementOut) {
    mkdirSync(dirname(managementOut), { recursive: true });
    writeFileSync(
      managementOut,
      `${JSON.stringify(
        {
          endpoint,
          adminEndpoint,
          issuer: `${endpoint}/oidc`,
          clientId: env('LOGTO_M2M_APP_ID', 'm-default'),
          clientSecret,
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    say(`wrote the management credential -> ${resolve(managementOut)}`);
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
