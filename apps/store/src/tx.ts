/**
 * The one way a route reaches the database.
 *
 * Two things happen here and they are inseparable: the tenant context established by the auth
 * hook is pushed into AsyncLocalStorage, and a transaction is opened that issues
 * `set_config('app.tenant_id', …, true)` -- SET LOCAL by another name -- before any statement of
 * the handler's runs (BE1, BE3).
 *
 * After that, no query in this app names a tenant. A forgotten predicate returns nothing rather
 * than another merchant's orders, and that property is only testable because the predicates are
 * not there (§3.5).
 */
import type { TenantContext } from '@mercatus/core';
import { requireTenantContext, runInTenant } from '@mercatus/core';
import type { StoreTx } from '@mercatus/db-store';
import { withTenantTx } from '@mercatus/db-store';
import type { FastifyRequest } from 'fastify';

import type { StoreDeps } from './deps.js';

export function inTenantTx<T>(
  deps: StoreDeps,
  req: FastifyRequest,
  fn: (tx: StoreTx, ctx: TenantContext) => Promise<T>,
): Promise<T> {
  const ctx = requireTenantContext(req);
  return runInTenant(ctx, () => withTenantTx(deps.db, (tx) => fn(tx, ctx)));
}
