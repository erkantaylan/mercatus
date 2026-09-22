/**
 * Tenants -- the control plane's own table, where a tenant id is MINTED (BV1). Every data plane
 * mirrors these rows; none of them creates one.
 *
 * The status machine is the whole of Q13: signup creates `pending`, payment activates, and the
 * console flips between `active` and `passive` afterwards (ES). `passive` is never a deletion and
 * never hides the merchant's own data from them (CG3).
 */
import { desc, eq, sql } from 'drizzle-orm';

import type { PlatformExecutor } from '../client.js';
import type { InstallationRow, LicenceRow, TenantRow, TenantStatus, TenantTier } from '../schema.js';
import { installations, licences, tenants } from '../schema.js';

export interface TenantInput {
  readonly slug: string;
  readonly name: string;
  readonly tier: TenantTier;
}

/** A tenant, and what the console shows beside it. Both halves may be absent. */
export interface TenantWithDetail {
  readonly tenant: TenantRow;
  readonly licence: LicenceRow | null;
  readonly installation: InstallationRow | null;
}

export async function findTenantBySlug(
  db: PlatformExecutor,
  slug: string,
): Promise<TenantRow | null> {
  const rows = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function findTenantById(db: PlatformExecutor, id: string): Promise<TenantRow | null> {
  const rows = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Created `pending`. Nothing here activates a tenant; only a settled payment does (Q13). */
export async function insertTenant(db: PlatformExecutor, input: TenantInput): Promise<TenantRow> {
  const rows = await db
    .insert(tenants)
    .values({ slug: input.slug, name: input.name, tier: input.tier, status: 'pending' })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('insertTenant returned no row');
  return row;
}

/**
 * The one place a tenant's status changes. `activatedAt` is stamped on the first transition into
 * `active` and never rewritten afterwards, so a passive-then-active tenant keeps the date it was
 * actually bought.
 */
export async function setTenantStatus(
  db: PlatformExecutor,
  id: string,
  status: TenantStatus,
): Promise<TenantRow | null> {
  const rows = await db
    .update(tenants)
    .set({
      status,
      ...(status === 'active'
        ? { activatedAt: sql`coalesce(${tenants.activatedAt}, now())` }
        : {}),
    })
    .where(eq(tenants.id, id))
    .returning();
  return rows[0] ?? null;
}

/** fake-bank's id, recorded as an ATTRIBUTE of the tenant. Never the tenant's identity (BV1). */
export async function setTenantPaymentRef(
  db: PlatformExecutor,
  id: string,
  paymentRef: string,
): Promise<void> {
  await db.update(tenants).set({ paymentRef }).where(eq(tenants.id, id));
}

async function detailFor(
  db: PlatformExecutor,
  rows: TenantRow[],
): Promise<TenantWithDetail[]> {
  if (rows.length === 0) return [];
  const licenceRows = await db.select().from(licences);
  const installationRows = await db.select().from(installations);
  const licenceByTenant = new Map(licenceRows.map((l) => [l.tenantId, l]));
  // Newest registration wins if a tenant somehow has two: the console shows the live box.
  const installationByTenant = new Map<string, InstallationRow>();
  for (const row of installationRows) {
    const current = installationByTenant.get(row.tenantId);
    if (!current || current.createdAt < row.createdAt) installationByTenant.set(row.tenantId, row);
  }
  return rows.map((tenant) => ({
    tenant,
    licence: licenceByTenant.get(tenant.id) ?? null,
    installation: installationByTenant.get(tenant.id) ?? null,
  }));
}

/**
 * The console's list. Two extra selects rather than a three-way outer join: the POC has tens of
 * tenants, the join's shape is the hard part to read, and this one is obviously correct.
 */
export async function listTenantDetail(
  db: PlatformExecutor,
  page: { limit: number; offset: number },
): Promise<{ items: TenantWithDetail[]; total: number }> {
  const rows = await db
    .select()
    .from(tenants)
    .orderBy(desc(tenants.createdAt))
    .limit(page.limit)
    .offset(page.offset);
  const counted = await db.select({ total: sql<number>`count(*)::int` }).from(tenants);
  return { items: await detailFor(db, rows), total: counted[0]?.total ?? 0 };
}

export async function findTenantDetailBySlug(
  db: PlatformExecutor,
  slug: string,
): Promise<TenantWithDetail | null> {
  const row = await findTenantBySlug(db, slug);
  if (!row) return null;
  const [detail] = await detailFor(db, [row]);
  return detail ?? null;
}
