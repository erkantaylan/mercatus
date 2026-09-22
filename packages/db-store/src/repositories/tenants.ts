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
import { eq, sql } from 'drizzle-orm';

import type { StoreDb, StoreTx } from '../client.js';
import type { Branding, TenantRow } from '../schema.js';
import { tenants } from '../schema.js';

/**
 * The reads go through SECURITY DEFINER functions, not through the table (OPEN-DEFECTS F2).
 *
 * `mercatus_app` no longer holds SELECT on `tenants`: in a pooled deployment that grant meant any
 * code path with a store connection could enumerate every merchant on the box, with no tenant
 * context at all. The functions are declared in sql/02-rls.sql and each returns only what its
 * caller needs -- one row by slug, one row by id, or the (id, slug) directory the pooled licence
 * agent polls from.
 *
 * The owner keeps direct access, which is why the write helpers below are still plain drizzle:
 * they run as `mercatus_owner` from the migrate step, the seed and the install command.
 */
interface TenantFunctionRow extends Record<string, unknown> {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly branding: Branding;
  readonly updated_at: Date;
}

function toRow(row: TenantFunctionRow): TenantRow {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    branding: row.branding,
    updatedAt: row.updated_at,
  };
}

export async function findTenantBySlug(db: StoreDb, slug: string): Promise<TenantRow | null> {
  const rows = await db.execute<TenantFunctionRow>(
    sql`select id, slug, name, branding, updated_at from mercatus_tenant_by_slug(${slug})`,
  );
  const row = rows[0];
  return row ? toRow(row) : null;
}

export async function findTenantById(db: StoreDb, id: string): Promise<TenantRow | null> {
  const rows = await db.execute<TenantFunctionRow>(
    sql`select id, slug, name, branding, updated_at from mercatus_tenant_by_id(${id}::uuid)`,
  );
  const row = rows[0];
  return row ? toRow(row) : null;
}

export interface TenantDirectoryRow extends Record<string, unknown> {
  readonly id: string;
  readonly slug: string;
}

/**
 * What this instance serves, for the licence agent's poll list. Id and slug and nothing else: a
 * poll list does not need a merchant's name or their branding.
 */
export async function listTenantDirectory(db: StoreDb): Promise<TenantDirectoryRow[]> {
  const rows = await db.execute<TenantDirectoryRow>(
    sql`select id, slug from mercatus_tenant_directory()`,
  );
  return [...rows];
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
