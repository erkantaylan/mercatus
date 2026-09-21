/**
 * @mercatus/db-platform -- the control plane's schema: users, tenants, memberships, licences,
 * installations and payments (BUILD-PLAN §5.1).
 *
 * No RLS: one database, one tenant, which is us. Tenant ids are minted here and mirrored into
 * every data plane (BV1).
 */
export * from './schema.js';
export * from './client.js';
export { SEED_TENANT_IDS, SEED_USER, seed } from './seed.js';
