/**
 * @mercatus/db-store -- the data plane's schema, roles, RLS, migrations, repositories and the
 * tenant transaction wrapper (BUILD-PLAN §5.2).
 *
 * Identical in pooled and dedicated deployments (CC2). The whole isolation guarantee lives in
 * sql/02-rls.sql and tenant-tx.ts: application code does not filter by tenant, and that is what
 * makes a forgotten filter return nothing instead of someone else's orders (BE1, §3.5).
 */
export * from './schema.js';
export * from './client.js';
export * from './tenant-tx.js';
export * from './repositories/tenants.js';
export * from './repositories/products.js';
export * from './repositories/shoppers.js';
export * from './repositories/orders.js';
export * from './repositories/licence-state.js';
export { SEED_TENANTS, seed } from './seed.js';
