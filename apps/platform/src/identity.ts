/**
 * The control plane's half of opt-in registration: teaching the issuer about an instance that
 * has just told us where it lives.
 *
 * Until v2.0.0 this did not exist. Every redirect URI was written once, at AppHost A's startup,
 * from an address a dedicated store had been assigned in advance -- and that advance knowledge
 * is exactly what made `MERCATUS_STORE_DEDICATED_PORT` a fixed number in two application models
 * that are otherwise forbidden to know about each other.
 *
 * Two properties are worth stating, because both were deliberate:
 *
 *   NO DATABASE. `packages/identity` reads the seeded M2M secret out of Logto's own `applications`
 *   table -- that is the only way into a fresh OSS instance without a human in a browser. THIS
 *   process may not do that: it is a schema we do not own (CD2), and the control plane holding a
 *   superuser URL to the issuer's database is a blast radius nobody asked for. The secret is
 *   handed over as configuration: `task-identity-bootstrap` writes it 0600 and we read it.
 *
 *   LAZY, AND NEVER FATAL. The credential file is opened on the first registration, not at boot.
 *   The platform has to be listening in seconds; Logto takes the better part of a minute to seed,
 *   and the bootstrap that writes this file runs after it. A control plane that would not start
 *   until the issuer was ready is the failure CG1 exists to prevent -- and one that cannot reach
 *   the issuer still registers the instance, still hands it a licence, and says so in the log.
 */
import { readFileSync } from 'node:fs';

import {
  installationApplicationName,
  deleteApplication,
  ensureInstallationClient,
  ensureOrganizationBySlug,
  LogtoManagementClient,
  reconcileRedirectUris,
  APPLICATION_NAMES,
} from '@mercatus/identity';
import { z } from 'zod';

import type { PlatformConfig } from './config.js';

const managementCredentialSchema = z.object({
  endpoint: z.url(),
  adminEndpoint: z.url(),
  issuer: z.url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

export type ManagementCredential = z.infer<typeof managementCredentialSchema>;

/** The URLs an instance reported, already host-checked. Only `baseUrl` is required. */
export interface InstanceUrls {
  readonly baseUrl: string;
  readonly dashboardUrl: string | null;
  readonly storefrontUrl: string | null;
}

export interface InstanceRegistration {
  readonly applicationId: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly organizationId: string | null;
  /**
   * What went wrong AFTER this instance's own client existed -- a shared application that would
   * not take the new callback, an organization lookup that failed.
   *
   * It is a warning and not an exception on purpose: the client is real, its secret is real, and
   * an instance told `oidc: null` because a PATCH on somebody else's application failed would
   * come up with no OIDC at all while the operator saw a clean registration. The caller logs
   * these; the instance is configured either way.
   */
  readonly warnings: readonly string[];
}

/**
 * Who else still needs a shared redirect URI.
 *
 * The dashboard and the storefront are ONE application each, shared by every tenant, so what one
 * installation adds to them another may be relying on. `previous` is what this installation had
 * registered before this call and `others` is every installation still on record; a URI is only
 * taken away when it is in `previous`, not in what is wanted now, and claimed by nobody in
 * `others`. Without that, deprovisioning a throwaway installation deletes a live one's callback
 * -- measured on a running stack, not theorised -- and re-registering on a new port leaks the old
 * one for ever.
 */
export interface SharedUriOwnership {
  readonly previous: InstanceUrls | null;
  readonly others: readonly InstanceUrls[];
}

/**
 * ONE spelling of a reported URL, decided once, before it is compared, stored or registered.
 *
 * Logto matches `redirect_uri` as a STRING, so a URL that is validated in one spelling and
 * registered in another is `oidc.invalid_redirect_uri` at the issuer -- the lessons/14 failure,
 * arriving by a different road. Phase 1 lower-cased the host for the pin CHECK only and stored
 * the caller's own spelling, so `HTTP://LOCALHOST:1234` passed the check and was registered
 * uppercase while the store sent lowercase.
 *
 * `URL.origin` gives the scheme and authority already lower-cased and with the default port
 * dropped, and `pathname` is percent-normalised. Userinfo, a query and a fragment are REFUSED
 * rather than stripped: none of them belongs in "where this box answers", each one is a parser
 * differential waiting for a consumer that disagrees with Node, and refusing is a sentence in the
 * log rather than a URL the caller did not ask for.
 *
 * Returns the reason it failed, for the LOG. The caller gives one generic answer (S1).
 */
export function normaliseReportedUrl(raw: string): { url: string } | { reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { reason: `reported URL is not a URL: ${raw}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { reason: `reported URL is not http(s): ${raw}` };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { reason: `reported URL carries userinfo: ${raw}` };
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    return { reason: `reported URL carries a query or fragment: ${raw}` };
  }
  // Trailing slashes go here and nowhere else: `…:4003/` and `…:4003` are two different
  // redirect URIs and two different clients' worth of debugging (lessons/14).
  return { url: `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '') };
}

/** The hostname a reported URL is on, for the pin check. `null` when it is not a usable URL. */
export function reportedHost(raw: string): string | null {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The three redirect URIs a dedicated instance needs, derived in ONE place so provisioning and
 * deprovisioning cannot drift apart (CK1).
 *
 * The inputs are already normalised by the route that accepted them, and normalised again here
 * so that a row written before `normaliseReportedUrl` existed cannot register one spelling and
 * deregister another. An unparseable stored URL yields no callbacks rather than a concatenation.
 */
function callbacks(urls: InstanceUrls): {
  store: string | null;
  dashboard: string | null;
  storefront: string | null;
  storefrontRoot: string | null;
} {
  const base = (u: string | null): string | null => {
    if (u === null) return null;
    const normalised = normaliseReportedUrl(u);
    return 'url' in normalised ? normalised.url : null;
  };
  const store = base(urls.baseUrl);
  const dashboard = base(urls.dashboardUrl);
  const storefront = base(urls.storefrontUrl);
  return {
    store: store === null ? null : `${store}/auth/callback`,
    dashboard: dashboard === null ? null : `${dashboard}/callback`,
    storefront: storefront === null ? null : `${storefront}/api/auth/callback`,
    storefrontRoot: storefront === null ? null : `${storefront}/`,
  };
}

/**
 * Opens the credential once and keeps the client. Returns null -- never throws -- when identity
 * is not wired up, which is the normal state of `AUTH_ADAPTER=stub` and of the test suite.
 */
export class IdentityProvisioner {
  readonly #config: PlatformConfig;
  #resolved: { client: LogtoManagementClient; credential: ManagementCredential } | null = null;
  #lastError: string | null = null;

  constructor(config: PlatformConfig) {
    this.#config = config;
  }

  #credential(): ManagementCredential | null {
    const { logtoManagementPath, logtoManagement } = this.#config;
    if (logtoManagement) return logtoManagement;
    if (!logtoManagementPath) return null;
    try {
      return managementCredentialSchema.parse(JSON.parse(readFileSync(logtoManagementPath, 'utf8')));
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  /** Null means "identity is not available"; `lastError()` says why, for the log (S1). */
  client(): { client: LogtoManagementClient; credential: ManagementCredential } | null {
    if (this.#resolved) return this.#resolved;
    const credential = this.#credential();
    if (!credential) return null;
    this.#resolved = {
      client: new LogtoManagementClient({
        endpoint: credential.endpoint,
        adminEndpoint: credential.adminEndpoint,
        clientId: credential.clientId,
        clientSecret: credential.clientSecret,
      }),
      credential,
    };
    return this.#resolved;
  }

  lastError(): string | null {
    return this.#lastError;
  }

  /**
   * Give this instance a client of its own and tell the issuer about its redirect URIs.
   *
   * Idempotent: re-registering the same instance at the same addresses changes nothing, which is
   * what a restart of AppHost B does every time. When the addresses CHANGED -- a restarted box
   * gets a new Aspire-assigned port -- the old shared callbacks are taken back out in the same
   * read-modify-write, unless another installation is still using them.
   *
   * `onApplicationCreated` is called the moment this instance's own client exists and BEFORE
   * anything else can fail. That ordering is the whole of it: without it a shared PATCH that
   * threw left a confidential client with a live secret at the issuer and nothing in our database
   * pointing at it, so deprovisioning could never reach it again.
   */
  async provision(input: {
    tenantSlug: string;
    installationId: string;
    urls: InstanceUrls;
    ownership: SharedUriOwnership;
    onApplicationCreated?: (applicationId: string) => Promise<void>;
  }): Promise<InstanceRegistration | null> {
    const resolved = this.client();
    if (!resolved) return null;
    const { client, credential } = resolved;
    const uris = callbacks(input.urls);

    // ALL THREE CALLBACKS GO ON THIS INSTANCE'S OWN CLIENT (v2.0.0). The store is the only OIDC
    // client on a dedicated box -- the storefront and the dashboard hold no secret and could not
    // authenticate as one -- so `${storefront}/api/auth/callback` and `${dashboard}/callback` are
    // redirect URIs of the STORE's client. Written authoritatively (lessons/16): this application
    // has exactly one owner, so a restarted box on a new Aspire-assigned port replaces its list
    // rather than growing it.
    const installation = await ensureInstallationClient(client, {
      name: installationApplicationName(input.tenantSlug, input.installationId),
      redirectUris: [uris.store, uris.storefront, uris.dashboard].filter(
        (uri): uri is string => uri !== null,
      ),
      postLogoutRedirectUris: uris.storefrontRoot === null ? [] : [uris.storefrontRoot],
    });
    // Before the shared applications, before the organization lookup, before anything that can
    // throw: an application id we cannot write down is a client secret nobody can ever revoke.
    if (input.onApplicationCreated) await input.onApplicationCreated(installation.applicationId);

    const warnings: string[] = [];
    const stale = staleSharedUris(input.ownership, uris);

    // The dashboard and the storefront are SPA/Traditional clients SHARED with the pooled plane
    // -- they carry no secret a dedicated box holds, so adding one more callback to each is the
    // cheap answer. What this installation no longer uses comes straight back out, unless one of
    // the `others` still needs it.
    await this.#reconcileShared(
      client,
      APPLICATION_NAMES.dashboard,
      uris.dashboard,
      stale.dashboard,
      warnings,
    );
    await this.#reconcileShared(
      client,
      APPLICATION_NAMES.storefront,
      uris.storefront,
      stale.storefront,
      warnings,
    );

    // CREATED when it is not there, not merely looked up (phase 3). An organization IS a tenant
    // (CD3), and a tenant bought after AppHost A started has none: the bootstrap makes one per
    // slug in a list fixed at A's startup. Settling for `null` here is what made the second
    // dedicated tenant a tenant whose merchant could never be recognised as its staff -- and
    // teaching A the list instead would put back exactly the advance knowledge v2.0.0 deletes.
    let organizationId: string | null = null;
    try {
      organizationId = await ensureOrganizationBySlug(client, input.tenantSlug);
    } catch (error) {
      warnings.push(`organization for ${input.tenantSlug} could not be resolved: ${message(error)}`);
    }

    return {
      applicationId: installation.applicationId,
      issuer: credential.issuer,
      clientId: installation.clientId,
      clientSecret: installation.clientSecret,
      organizationId,
      warnings,
    };
  }

  /** One shared application: add what is wanted, take back what is nobody's. Never throws. */
  async #reconcileShared(
    client: LogtoManagementClient,
    name: string,
    wanted: string | null,
    stale: readonly string[],
    warnings: string[],
  ): Promise<void> {
    if (wanted === null && stale.length === 0) return;
    try {
      await reconcileRedirectUris(client, name, {
        add: wanted === null ? [] : [wanted],
        remove: stale,
      });
    } catch (error) {
      warnings.push(`${name}: redirect URIs not updated: ${message(error)}`);
    }
  }

  /**
   * Built at the same time as provisioning, not after it (CK1). Without it the redirect-URI list
   * grows for ever and every instance we ever deprovisioned keeps a working client secret.
   *
   * `ownership.others` is not optional courtesy: a URI another live installation reported is left
   * alone. The first version of this did a blind set-difference and, on a running stack, deleting
   * a throwaway installation took a serving box's callback out of the shared dashboard client.
   */
  async deprovision(input: {
    applicationId: string | null;
    urls: InstanceUrls | null;
    others: readonly InstanceUrls[];
  }): Promise<boolean> {
    const resolved = this.client();
    if (!resolved) return false;
    const { client } = resolved;
    if (input.applicationId) await deleteApplication(client, input.applicationId);
    if (input.urls) {
      const stale = staleSharedUris({ previous: input.urls, others: input.others }, null);
      const warnings: string[] = [];
      await this.#reconcileShared(client, APPLICATION_NAMES.dashboard, null, stale.dashboard, warnings);
      await this.#reconcileShared(
        client,
        APPLICATION_NAMES.storefront,
        null,
        stale.storefront,
        warnings,
      );
      if (warnings.length > 0) throw new Error(warnings.join('; '));
    }
    return true;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The shared callbacks this installation used to hold and nobody else does -- the exact set that
 * may be removed.
 *
 * `wanted` is what it holds after this call, or null when it is going away entirely. Anything in
 * `wanted` is never stale, and anything another installation reported is never stale even if this
 * one reported it too: two boxes on one address is a strange topology, not a licence to break the
 * one that is still serving.
 */
function staleSharedUris(
  ownership: SharedUriOwnership,
  wanted: ReturnType<typeof callbacks> | null,
): { dashboard: string[]; storefront: string[] } {
  const previous = ownership.previous === null ? null : callbacks(ownership.previous);
  if (previous === null) return { dashboard: [], storefront: [] };

  const claimed = { dashboard: new Set<string>(), storefront: new Set<string>() };
  for (const other of ownership.others) {
    const theirs = callbacks(other);
    if (theirs.dashboard) claimed.dashboard.add(theirs.dashboard);
    if (theirs.storefront) claimed.storefront.add(theirs.storefront);
  }

  const stale = (
    was: string | null,
    is: string | null | undefined,
    others: ReadonlySet<string>,
  ): string[] => (was !== null && was !== is && !others.has(was) ? [was] : []);

  return {
    dashboard: stale(previous.dashboard, wanted?.dashboard ?? null, claimed.dashboard),
    storefront: stale(previous.storefront, wanted?.storefront ?? null, claimed.storefront),
  };
}
