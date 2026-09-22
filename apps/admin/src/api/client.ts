/**
 * The console's one way to reach the control plane.
 *
 * Every call goes through `request()`, so the bearer token, the error envelope and the response
 * parse are decided once. `PLATFORM_URL` is §8.2's name for this; Vite only exposes variables
 * prefixed `VITE_`, so the console reads `VITE_PLATFORM_URL` -- the same treatment
 * `VITE_STORE_API_URL` already gets in that table.
 */
import type { z } from 'zod';

import { clearSession, readSession } from '../auth/session.js';

import {
  devLoginResultSchema,
  errorEnvelopeSchema,
  installationListSchema,
  tenantListSchema,
  tenantSummarySchema,
} from './schemas.js';
import type { LicenceStatus, TenantSummary } from './schemas.js';

export const PLATFORM_URL: string =
  import.meta.env.VITE_PLATFORM_URL ?? 'http://127.0.0.1:4001';

/** A refusal from the control plane, carrying the envelope's code so a screen can react to it. */
export class PlatformError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'PlatformError';
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
  /** Only the dev login is anonymous; everything else needs the operator token. */
  readonly anonymous?: boolean;
}

async function request<T extends z.ZodTypeAny>(
  path: string,
  schema: T,
  options: RequestOptions = {},
): Promise<z.infer<T>> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  if (!options.anonymous) {
    const session = readSession();
    if (!session) throw new PlatformError(401, 'UNAUTHENTICATED', 'Sign in again.');
    headers['authorization'] = `Bearer ${session.accessToken}`;
  }

  const response = await fetch(`${PLATFORM_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  if (!response.ok) {
    // The token outlived its usefulness mid-session; drop it so the guard sends us to /login
    // rather than letting every screen render an authentication error.
    if (response.status === 401) clearSession();
    const envelope = errorEnvelopeSchema.safeParse(await response.json().catch(() => null));
    throw new PlatformError(
      response.status,
      envelope.success ? envelope.data.error.code : 'INTERNAL',
      envelope.success ? envelope.data.error.message : `The control plane answered ${String(response.status)}.`,
    );
  }

  return schema.parse(await response.json()) as z.infer<T>;
}

/** `POST /dev/login/operator`. Registered only while AUTH_ADAPTER=stub. */
export async function devLoginOperator(subject: string): Promise<{
  accessToken: string;
  expiresAt: number;
}> {
  return request('/dev/login/operator', devLoginResultSchema, {
    method: 'POST',
    body: { subject },
    anonymous: true,
  });
}

export async function listTenants(): Promise<{ items: TenantSummary[]; total: number }> {
  return request('/tenants?limit=100', tenantListSchema);
}

export async function getTenant(slug: string): Promise<TenantSummary> {
  return request(`/tenants/${encodeURIComponent(slug)}`, tenantSummarySchema);
}

export async function listInstallations(): Promise<
  z.infer<typeof installationListSchema>
> {
  return request('/installations', installationListSchema);
}

/**
 * `POST /tenants/:slug/licence` -- the flip (CG3, ES).
 *
 * Passive blocks the money-making action and leaves everything else alone: the storefront still
 * browses, the merchant's dashboard stays fully usable, and nothing is deleted. It is never set
 * because WE could not be reached -- that is a different state, computed in the data plane, and
 * the console must never be able to collapse the two.
 */
export async function setLicenceStatus(
  slug: string,
  status: LicenceStatus,
): Promise<TenantSummary> {
  return request(`/tenants/${encodeURIComponent(slug)}/licence`, tenantSummarySchema, {
    method: 'POST',
    body: { status },
  });
}

/**
 * The same endpoint, changing what the tenant is ENTITLED to rather than whether they may sell.
 *
 * CC3 is the whole reason this exists as a console action: a feature is gated by a row in the
 * licence, not by a build. Turning `whiteLabel` on removes the "a store on mercatus" mark from
 * that merchant's storefront within one poll interval, with nothing rebuilt and no second image.
 */
export async function setEntitlements(
  slug: string,
  status: LicenceStatus,
  entitlements: Record<string, boolean>,
): Promise<TenantSummary> {
  return request(`/tenants/${encodeURIComponent(slug)}/licence`, tenantSummarySchema, {
    method: 'POST',
    body: { status, entitlements },
  });
}
