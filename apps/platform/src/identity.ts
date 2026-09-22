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
  addRedirectUris,
  installationApplicationName,
  deleteApplication,
  ensureInstallationClient,
  findOrganizationIdBySlug,
  LogtoManagementClient,
  removeRedirectUris,
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
}

/**
 * The three redirect URIs a dedicated instance needs, derived in ONE place so provisioning and
 * deprovisioning cannot drift apart (CK1). Trailing slashes are stripped first: Logto matches a
 * redirect_uri as a string, so `…:4003/` and `…:4003` are two different clients' worth of
 * debugging (lessons/14).
 */
function callbacks(urls: InstanceUrls): {
  store: string;
  dashboard: string | null;
  storefront: string | null;
  storefrontRoot: string | null;
} {
  const trim = (u: string): string => u.replace(/\/+$/, '');
  return {
    store: `${trim(urls.baseUrl)}/auth/callback`,
    dashboard: urls.dashboardUrl === null ? null : `${trim(urls.dashboardUrl)}/callback`,
    storefront: urls.storefrontUrl === null ? null : `${trim(urls.storefrontUrl)}/api/auth/callback`,
    storefrontRoot: urls.storefrontUrl === null ? null : `${trim(urls.storefrontUrl)}/`,
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
   * Idempotent: re-registering the same instance at the same addresses changes nothing, which is
   * what a restart of AppHost B does every time.
   */
  async provision(
    tenantSlug: string,
    installationId: string,
    urls: InstanceUrls,
  ): Promise<InstanceRegistration | null> {
    const resolved = this.client();
    if (!resolved) return null;
    const { client, credential } = resolved;
    const uris = callbacks(urls);

    const installation = await ensureInstallationClient(client, {
      name: installationApplicationName(tenantSlug, installationId),
      redirectUris: [uris.store],
      postLogoutRedirectUris: uris.storefrontRoot === null ? [] : [uris.storefrontRoot],
    });

    // The dashboard and the storefront are SPA/Traditional clients SHARED with the pooled plane
    // -- they carry no secret a dedicated box holds, so adding one more callback to each is the
    // cheap answer and `removeRedirectUris` takes it back out again.
    if (uris.dashboard) {
      await addRedirectUris(client, APPLICATION_NAMES.dashboard, {
        redirectUris: [uris.dashboard],
      });
    }
    if (uris.storefront) {
      await addRedirectUris(client, APPLICATION_NAMES.storefront, {
        redirectUris: [uris.storefront],
      });
    }

    return {
      applicationId: installation.applicationId,
      issuer: credential.issuer,
      clientId: installation.clientId,
      clientSecret: installation.clientSecret,
      organizationId: await findOrganizationIdBySlug(client, tenantSlug),
    };
  }

  /**
   * Built at the same time as provisioning, not after it (CK1). Without it the redirect-URI list
   * grows for ever and every instance we ever deprovisioned keeps a working client secret.
   */
  async deprovision(input: {
    applicationId: string | null;
    urls: InstanceUrls | null;
  }): Promise<boolean> {
    const resolved = this.client();
    if (!resolved) return false;
    const { client } = resolved;
    if (input.applicationId) await deleteApplication(client, input.applicationId);
    if (input.urls) {
      const uris = callbacks(input.urls);
      if (uris.dashboard) {
        await removeRedirectUris(client, APPLICATION_NAMES.dashboard, {
          redirectUris: [uris.dashboard],
        });
      }
      if (uris.storefront) {
        await removeRedirectUris(client, APPLICATION_NAMES.storefront, {
          redirectUris: [uris.storefront],
        });
      }
    }
    return true;
  }
}
