/**
 * Database rows -> the shapes in @mercatus/contracts and ./schemas.ts.
 *
 * Explicit, never a spread: a column added to the schema should not appear on the wire until
 * someone decides it should. Timestamps become ISO strings here and nowhere else.
 */
import type { LicencePollResult, Tenant, TenantSummary } from '@mercatus/contracts';
import type { InstallationRow, LicenceRow, TenantRow, TenantWithDetail } from '@mercatus/db-platform';

import type { InstallationView } from './schemas.js';

/**
 * A tenant's status decides what its licence currently permits. `pending` and `passive` are both
 * "no checkout" on the wire; the two are kept apart in `tenants.status`, where the console can
 * see which it is, because "has not paid yet" and "was suspended" are fixed by different people
 * (CG3).
 */
export function licenceStatusOf(tenant: TenantRow): 'active' | 'passive' {
  return tenant.status === 'active' ? 'active' : 'passive';
}

export function tenantDto(row: TenantRow): Tenant {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    tier: row.tier,
    createdAt: row.createdAt.toISOString(),
    activatedAt: row.activatedAt?.toISOString() ?? null,
  };
}

export function tenantSummaryDto(detail: TenantWithDetail): TenantSummary {
  const { tenant, licence, installation } = detail;
  return {
    ...tenantDto(tenant),
    licence: licence
      ? {
          status: licenceStatusOf(tenant),
          entitlements: licence.entitlements,
          validUntil: licence.validUntil,
        }
      : null,
    installation: installation
      ? {
          id: installation.id,
          version: installation.version,
          lastSeenAt: installation.lastSeenAt?.toISOString() ?? null,
          productCount: installation.productCount,
          orderCount: installation.orderCount,
        }
      : null,
  };
}

export function installationDto(row: InstallationRow, tenantSlug: string): InstallationView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    tenantSlug,
    expectedHost: row.expectedHost,
    baseUrl: row.baseUrl,
    dashboardUrl: row.dashboardUrl,
    storefrontUrl: row.storefrontUrl,
    version: row.version,
    licenceId: row.licenceId,
    productCount: row.productCount,
    orderCount: row.orderCount,
    registeredAt: row.registeredAt?.toISOString() ?? null,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
  };
}

/**
 * What a data plane polls for (CE4). `serverTime` is ours on purpose: an instance measures its
 * grace window against our clock rather than its own, so a box with a wrong date cannot extend
 * its own licence by being wrong (CG2).
 */
export function licencePollDto(tenant: TenantRow, licence: LicenceRow | null): LicencePollResult {
  return {
    status: licenceStatusOf(tenant),
    entitlements: licence?.entitlements ?? {},
    validUntil: licence?.validUntil ?? null,
    serverTime: new Date().toISOString(),
    licenceId: licence?.id ?? null,
  };
}
