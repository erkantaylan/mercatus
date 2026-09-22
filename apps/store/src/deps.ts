/**
 * What every route needs, assembled once at boot and passed by closure.
 *
 * There is no container and no injection: five fields and a function argument do the job, and the
 * composition root below is the only place that knows how they are built.
 */
import { readFileSync } from 'node:fs';

import type { AuthAdapter, StoreConfig, TenantDirectory, TenantRef } from '@mercatus/core';
import type { StoreDb, StoreDbHandle, TenantRow } from '@mercatus/db-store';
import { createStoreDb, findTenantById, findTenantBySlug } from '@mercatus/db-store';

export interface StoreDeps {
  readonly config: StoreConfig;
  readonly db: StoreDb;
  readonly adapter: AuthAdapter;
  /** Reported on /health and on every telemetry batch (CE6). Never assumed by the control plane. */
  readonly version: string;
  readonly tenants: TenantDirectory;
}

/** The running build, from package.json. A store that cannot say what it is fails CE6. */
export function readVersion(): string {
  const url = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: string };
  return pkg.version ?? '0.0.0';
}

function toRef(row: TenantRow | null): TenantRef | null {
  return row ? { id: row.id, slug: row.slug } : null;
}

/**
 * The lookup that turns a candidate slug into a tenant. It reads `tenants`, the one data-plane
 * table without RLS -- a policy on it would need the context that reading it produces.
 */
export function tenantDirectory(db: StoreDb): TenantDirectory {
  return {
    bySlug: async (slug) => toRef(await findTenantBySlug(db, slug)),
    byId: async (id) => toRef(await findTenantById(db, id)),
  };
}

export function openDatabase(config: StoreConfig): StoreDbHandle {
  // The app role, NOBYPASSRLS. A server process never holds the owner's connection string (BE2).
  return createStoreDb(config.databaseUrl, { max: 10 });
}
