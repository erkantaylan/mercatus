/**
 * The tenant lookup -- and the ONE place in the data plane allowed to write a tenant predicate
 * (BUILD-PLAN §3.5).
 *
 * `tenants` has no RLS, because it is what establishes tenant context: a policy on it would need
 * the context that reading it produces. So the predicates here are hand-written, they are the
 * only hand-written ones, and the leak suite's grep names this file as its single exception.
 *
 * Everything else in the data plane relies on RLS. Do not "helpfully" add a tenant filter to
 * another repository: a forgotten filter must return nothing, and you cannot test that property
 * if the filters are there (BE1).
 */
import { eq } from 'drizzle-orm';

import type { StoreDb, StoreTx } from '../client.js';
import type { Branding, TenantRow } from '../schema.js';
import { tenants } from '../schema.js';

export async function findTenantBySlug(db: StoreDb, slug: string): Promise<TenantRow | null> {
  const rows = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function findTenantById(db: StoreDb, id: string): Promise<TenantRow | null> {
  const rows = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listTenants(db: StoreDb): Promise<TenantRow[]> {
  return db.select().from(tenants).orderBy(tenants.slug);
}

export interface MirrorTenantInput {
  /** Minted by the control plane (BV1). The data plane never invents one. */
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly branding?: Branding;
}

/**
 * Mirrors a control-plane tenant into the data plane. Idempotent, because provisioning has to be
 * resumable (CK2) and a dedicated instance re-pulls its own row on every boot.
 *
 * Runs as the owner: mercatus_app has SELECT on this table and nothing else.
 */
export async function mirrorTenant(tx: StoreTx, input: MirrorTenantInput): Promise<void> {
  await tx
    .insert(tenants)
    .values({
      id: input.id,
      slug: input.slug,
      name: input.name,
      ...(input.branding === undefined ? {} : { branding: input.branding }),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: tenants.id,
      set: {
        slug: input.slug,
        name: input.name,
        ...(input.branding === undefined ? {} : { branding: input.branding }),
        updatedAt: new Date(),
      },
    });
}

/** Updates a tenant's display name and branding. The dashboard's settings screen (DW). */
export async function updateTenantSettings(
  tx: StoreTx,
  id: string,
  patch: { name?: string; branding?: Branding },
): Promise<void> {
  await tx
    .update(tenants)
    .set({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.branding === undefined ? {} : { branding: patch.branding }),
      updatedAt: new Date(),
    })
    .where(eq(tenants.id, id));
}
