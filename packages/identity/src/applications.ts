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

/**
 * Add and remove in ONE read-modify-write, on an existing application, by name. Missing app ->
 * false. Idempotent: a call that changes nothing issues no PATCH.
 *
 * Add-and-remove together rather than two calls, because they are two halves of one fact. A
 * dedicated instance that comes back on a new Aspire-assigned port wants its new callback added
 * and its old one taken away; doing that as `add` then `remove` leaves a window in which the
 * shared application carries both, and doing only the `add` -- which is what v2.0.0 phase 1 did
 * -- leaks one dead URI per restart, for ever, on an application every tenant shares.
 *
 * `remove` is applied FIRST and `add` second, so a URI named in both survives. The caller's job
 * is to have already subtracted anything another installation still needs: this function knows
 * about strings, not about ownership.
 */
export async function reconcileRedirectUris(
  client: LogtoManagementClient,
  name: string,
  input: {
    add?: readonly string[];
    remove?: readonly string[];
    addPostLogout?: readonly string[];
    removePostLogout?: readonly string[];
  },
): Promise<boolean> {
  const app = await findApplicationByName(client, name);
  if (!app) return false;
  return writeUris(
    client,
    app,
    union(difference(app.oidcClientMetadata?.redirectUris, input.remove ?? []), input.add ?? []),
    union(
      difference(app.oidcClientMetadata?.postLogoutRedirectUris, input.removePostLogout ?? []),
      input.addPostLogout ?? [],
    ),
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
    // AUTHORITATIVE, not a union. This application belongs to exactly ONE installation, so there
    // is no other owner whose callback a replacement could break -- and the instance's port is
    // assigned by its own orchestrator, so a union grows this list by one dead URI on every
    // restart. (Measured: one restart of AppHost B left both `…:19015/auth/callback` and
    // `…:17031/auth/callback` on it.) The shared dashboard and storefront clients are the ones
    // that need ownership arithmetic, and they get it in `reconcileRedirectUris`.
    await writeUris(
      client,
      existing,
      [...input.redirectUris],
      [...(input.postLogoutRedirectUris ?? [])],
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

/**
 * The same lookup, and it CREATES the organization when the issuer has never heard of this
 * tenant (v2.0.0 phase 3).
 *
 * A tenant that was bought after AppHost A started -- which is every tenant, in the product --
 * has no organization at the issuer: `bootstrap.ts` makes one per slug in `IDENTITY_TENANT_SLUGS`
 * and that list is a development literal fixed at A's startup. Looking one up and settling for
 * `null` handed the instance an identity cache with an empty organization directory, so the box
 * could verify a user's token and never an organization's: its merchant could not be recognised
 * as staff of their own store. The blocker was measured on `orion`, the second dedicated tenant.
 *
 * Creating it HERE is what keeps "a new dedicated tenant is zero edits to AppHost A" true. The
 * alternative -- teaching A the list of slugs -- is the coupling v2.0.0 exists to delete, one
 * layer up: A would again have to know a tenant before that tenant existed.
 *
 * Idempotent (CK2), and racing is harmless: two registrations at once may both POST, and Logto
 * answers the loser 4xx on the unique name, so we look again rather than propagate it.
 */
export async function ensureOrganizationBySlug(
  client: LogtoManagementClient,
  slug: string,
): Promise<string> {
  const existing = await findOrganizationIdBySlug(client, slug);
  if (existing !== null) return existing;
  try {
    const created = await client.post<{ id: string }>('/organizations', {
      name: slug,
      description: `Mercatus tenant ${slug}`,
      // Our own tenant id is deliberately absent: Logto generates the organization id and the
      // control plane minted the tenant id (BV1). The slug is the join, and it is the name.
      customData: { slug },
    });
    return created.id;
  } catch (error) {
    const raced = await findOrganizationIdBySlug(client, slug);
    if (raced !== null) return raced;
    throw error;
  }
}
