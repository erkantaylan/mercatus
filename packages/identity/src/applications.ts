/**
 * Registering a surface's redirect URIs at the issuer, AT RUNTIME.
 *
 * Until v2.0.0 every redirect URI in this repo was written once, by the bootstrap task, from an
 * address AppHost A had been told in advance. That is what forced a dedicated store onto a fixed
 * port: a redirect URI the issuer has not been told about is refused at the end of the login
 * round trip, so the control plane had to know the address of a box that did not exist yet.
 *
 * Now the instance says where it lives (`POST /installations/register`) and the control plane
 * calls this. Two rules make it safe to call repeatedly:
 *
 *   - every write is a READ-MODIFY-WRITE. `PATCH /api/applications/:id` with
 *     `{oidcClientMetadata:{redirectUris:[...]}}` REPLACES the list; appending is our job.
 *   - it is a set union, so re-registering the same URL changes nothing and a restarted instance
 *     does not grow the list by one every time (the sibling of CK1: what is added is removable).
 *
 * A dedicated instance gets its OWN application (CE1) rather than the pooled store's client:
 * the box's owner has root, and one leaked client secret on one merchant's VPS must not be every
 * merchant's incident. `removeInstallationClient` deletes it again at deprovisioning (CK1).
 */
import type { LogtoManagementClient } from './logto.js';

/**
 * The names the bootstrap registers, and the only join between it and anything that looks an
 * application up later. Logto generates application ids, so the NAME is the stable handle --
 * exactly as the organization's name carries our tenant slug (lessons/08).
 */
export const APPLICATION_NAMES = {
  storePooled: 'Mercatus store (pooled)',
  dashboard: 'Mercatus dashboard',
  admin: 'Mercatus platform console',
  storefront: 'Mercatus storefront',
} as const;

/**
 * One application per INSTALLATION -- not per tenant, and the difference is not cosmetic.
 *
 * The client secret in it is this box's (CE1), so two boxes serving one tenant are two
 * credentials; and deprovisioning one of them DELETES its application. Keyed by slug alone, the
 * second installation of a tenant would silently take over the first one's client and then take
 * it away again when it was retired -- with the first box still serving, holding a secret that no
 * longer exists. Measured, not imagined: registering a second zenith installation put both
 * redirect URIs on one application.
 *
 * The slug is in the name anyway, because a human reading Logto's application list should not
 * have to resolve a uuid to know whose box it is.
 */
export function installationApplicationName(slug: string, installationId: string): string {
  return `Mercatus store (tenant ${slug} / ${installationId})`;
}

export interface LogtoApplication {
  readonly id: string;
  readonly name: string;
  readonly oidcClientMetadata?: {
    readonly redirectUris?: readonly string[];
    readonly postLogoutRedirectUris?: readonly string[];
  };
}

export async function findApplicationByName(
  client: LogtoManagementClient,
  name: string,
): Promise<LogtoApplication | null> {
  const all = await client.get<LogtoApplication[]>('/applications');
  return all.find((app) => app.name === name) ?? null;
}

/** The usable secret is never the `secret` column for an app made through the API (lessons/08). */
export async function applicationSecret(
  client: LogtoManagementClient,
  applicationId: string,
): Promise<string> {
  const secrets = await client.get<{ value: string }[]>(`/applications/${applicationId}/secrets`);
  return secrets[0]?.value ?? '';
}

function union(existing: readonly string[] | undefined, wanted: readonly string[]): string[] {
  const set = new Set(existing ?? []);
  for (const uri of wanted) set.add(uri);
  return [...set];
}

function difference(existing: readonly string[] | undefined, unwanted: readonly string[]): string[] {
  const drop = new Set(unwanted);
  return (existing ?? []).filter((uri) => !drop.has(uri));
}

async function writeUris(
  client: LogtoManagementClient,
  app: LogtoApplication,
  redirectUris: string[],
  postLogoutRedirectUris: string[],
): Promise<boolean> {
  const before = app.oidcClientMetadata;
  const same =
    JSON.stringify([...(before?.redirectUris ?? [])].sort()) ===
      JSON.stringify([...redirectUris].sort()) &&
    JSON.stringify([...(before?.postLogoutRedirectUris ?? [])].sort()) ===
      JSON.stringify([...postLogoutRedirectUris].sort());
  if (same) return false;
  await client.patch(`/applications/${app.id}`, {
    oidcClientMetadata: { redirectUris, postLogoutRedirectUris },
  });
  return true;
}

/** Adds redirect URIs to an EXISTING application, by name. Idempotent. Missing app -> false. */
export async function addRedirectUris(
  client: LogtoManagementClient,
  name: string,
  input: { redirectUris?: readonly string[]; postLogoutRedirectUris?: readonly string[] },
): Promise<boolean> {
  const app = await findApplicationByName(client, name);
  if (!app) return false;
  return writeUris(
    client,
    app,
    union(app.oidcClientMetadata?.redirectUris, input.redirectUris ?? []),
    union(app.oidcClientMetadata?.postLogoutRedirectUris, input.postLogoutRedirectUris ?? []),
  );
}

/** The other half of the pair (CK1). Removing what was never added is a no-op, not a failure. */
export async function removeRedirectUris(
  client: LogtoManagementClient,
  name: string,
  input: { redirectUris?: readonly string[]; postLogoutRedirectUris?: readonly string[] },
): Promise<boolean> {
  const app = await findApplicationByName(client, name);
  if (!app) return false;
  return writeUris(
    client,
    app,
    difference(app.oidcClientMetadata?.redirectUris, input.redirectUris ?? []),
    difference(app.oidcClientMetadata?.postLogoutRedirectUris, input.postLogoutRedirectUris ?? []),
  );
}

export interface InstallationClient {
  readonly applicationId: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * This instance's own confidential client, created on first registration and reconciled on every
 * one after it. `clientId` IS the application id in Logto; they are returned separately because
 * only one of them is a thing the instance puts in a URL.
 */
export async function ensureInstallationClient(
  client: LogtoManagementClient,
  input: {
    name: string;
    redirectUris: readonly string[];
    postLogoutRedirectUris?: readonly string[];
  },
): Promise<InstallationClient> {
  const existing = await findApplicationByName(client, input.name);
  const app =
    existing ??
    (await client.post<LogtoApplication>('/applications', {
      name: input.name,
      // Traditional: the store exchanges the code server-side and then issues its OWN session
      // cookie, which is what keeps a signed-in shopper checking out while we are down.
      type: 'Traditional',
      description: 'Created by the control plane when this instance registered (v2.0.0).',
      oidcClientMetadata: {
        redirectUris: [...input.redirectUris],
        postLogoutRedirectUris: [...(input.postLogoutRedirectUris ?? [])],
      },
    }));
  if (existing) {
    await writeUris(
      client,
      existing,
      union(existing.oidcClientMetadata?.redirectUris, input.redirectUris),
      union(existing.oidcClientMetadata?.postLogoutRedirectUris, input.postLogoutRedirectUris ?? []),
    );
  }
  return {
    applicationId: app.id,
    clientId: app.id,
    clientSecret: await applicationSecret(client, app.id),
  };
}

/** Deprovisioning (CK1). A 404 from Logto means somebody got there first, which is success. */
export async function deleteApplication(
  client: LogtoManagementClient,
  applicationId: string,
): Promise<void> {
  try {
    await client.del(`/applications/${applicationId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/-> 404/.test(message)) throw error;
  }
}

/**
 * Our tenant slug is an organization NAME in Logto, never its id (BV1). The instance needs the
 * id so it can verify an organization token offline from its very first request -- and it is
 * given ONLY its own, not the directory of every tenant we have.
 */
export async function findOrganizationIdBySlug(
  client: LogtoManagementClient,
  slug: string,
): Promise<string | null> {
  const organizations = await client.get<{ id: string; name: string }[]>('/organizations');
  return organizations.find((org) => org.name === slug)?.id ?? null;
}
