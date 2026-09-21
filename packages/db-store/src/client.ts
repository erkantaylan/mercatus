/**
 * The data-plane connection (BUILD-PLAN §5.2).
 *
 * Two URLs, and the difference is the whole of BE2:
 *   DATABASE_URL       -> mercatus_app,   LOGIN NOBYPASSRLS. The only one the server process gets.
 *   DATABASE_ADMIN_URL -> mercatus_owner, owns the schema. Migrations and seed only.
 *
 * A superuser bypasses RLS even with `force row level security`, so connecting the app as
 * `postgres` silently turns every policy in sql/02-rls.sql into a comment. That is the failure
 * BE2 exists to prevent, and nothing in the code can detect it -- the queries just start working
 * on other tenants' rows.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema.js';

export type StoreSchema = typeof schema;
export type StoreDb = PostgresJsDatabase<StoreSchema>;

/**
 * The transaction handle handed to withTenantTx's callback. Derived from the driver rather than
 * spelled out, so a drizzle upgrade cannot leave a stale hand-written type behind.
 */
export type StoreTx = Parameters<Parameters<StoreDb['transaction']>[0]>[0];

export interface StoreDbHandle {
  readonly db: StoreDb;
  close(): Promise<void>;
}

export interface StoreDbOptions {
  /** Pool size. Small on purpose: a data plane serves one machine's worth of traffic. */
  readonly max?: number;
  /** Seconds. postgres.js closes idle connections rather than holding them open. */
  readonly idleTimeout?: number;
}

export function createStoreDb(url: string, options: StoreDbOptions = {}): StoreDbHandle {
  const client = postgres(url, {
    max: options.max ?? 10,
    idle_timeout: options.idleTimeout ?? 20,
    // BE3 depends on transaction-scoped state, so the driver must never hand back a connection
    // mid-transaction. postgres.js does not multiplex; this is a reminder, not a setting.
    onnotice: () => {},
  });
  const db = drizzle(client, { schema });
  return {
    db,
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };
}
