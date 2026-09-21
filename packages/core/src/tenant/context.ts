/**
 * Tenant context, carried by AsyncLocalStorage for the life of one request (BUILD-PLAN §3.1).
 *
 * This is the load-bearing module of the POC. Nothing reads a tenant from a parameter that was
 * threaded through five call sites, and nothing defaults to "some tenant": the context is either
 * established or the call fails (BE1).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { MissingTenantContextError } from '../errors.js';

export interface TenantContext {
  /** uuid from tenants.id. Never a slug (BV3: slugs are for URLs, uuids are keys). */
  readonly tenantId: string;
  readonly slug: string;
  /** Where the tenant came from, for audit and for the BI1/BI2 assertions. */
  readonly source: 'token' | 'route' | 'deployment';
  /** Token subject, when the request is authenticated. Required for shopper scoping (BI2). */
  readonly subject?: string;
}

const storage = new AsyncLocalStorage<TenantContext>();

export function runInTenant<T>(ctx: TenantContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

/** Throws MissingTenantContextError. Fail loudly; never default to "some tenant". */
export function currentTenant(): TenantContext {
  const ctx = storage.getStore();
  if (!ctx) throw new MissingTenantContextError();
  return ctx;
}

/** For the handful of places that legitimately run outside a tenant: health, docs, boot. */
export function tryCurrentTenant(): TenantContext | undefined {
  return storage.getStore();
}
