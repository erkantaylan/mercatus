/**
 * Every data-plane query goes through here (BUILD-PLAN §3.2).
 *
 * The tenant is pushed into the transaction and Postgres RLS -- not this code -- decides what the
 * query can see (BE1). The point of the arrangement is that a forgotten filter returns nothing
 * instead of another tenant's orders, and you can only have that property if the filters are not
 * there to begin with (§3.5).
 *
 * set_config(name, value, is_local => true) is exactly SET LOCAL, but it is a function call, so
 * the tenant id binds as a parameter. `SET LOCAL app.tenant_id = $1` is not valid SQL: SET does
 * not take bind parameters. Do not rebuild that statement by interpolation.
 *
 * Per transaction, never per connection (BE3): connection-scoped state plus a pool is a data-leak
 * generator, and the leak is intermittent, which is worse.
 */
import { currentTenant } from '@mercatus/core';
import { sql } from 'drizzle-orm';

import type { StoreDb, StoreTx } from './client.js';

export async function withTenantTx<T>(db: StoreDb, fn: (tx: StoreTx) => Promise<T>): Promise<T> {
  const { tenantId } = currentTenant();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

/**
 * The same thing with the tenant passed explicitly. For migrations, seeds and tests -- the three
 * places that legitimately have a tenant id without a request behind it. Application code uses
 * withTenantTx so the tenant can only come from the context that BI1/BI2 established.
 */
export async function withExplicitTenantTx<T>(
  db: StoreDb,
  tenantId: string,
  fn: (tx: StoreTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
