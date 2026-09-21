/**
 * The control-plane connection. One database, one tenant -- us -- so there is no tenant
 * transaction wrapper here and no RLS to push a setting into.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema.js';

export type PlatformSchema = typeof schema;
export type PlatformDb = PostgresJsDatabase<PlatformSchema>;
export type PlatformTx = Parameters<Parameters<PlatformDb['transaction']>[0]>[0];

export interface PlatformDbHandle {
  readonly db: PlatformDb;
  close(): Promise<void>;
}

export function createPlatformDb(url: string, options: { max?: number } = {}): PlatformDbHandle {
  const client = postgres(url, { max: options.max ?? 10, idle_timeout: 20, onnotice: () => {} });
  const db = drizzle(client, { schema });
  return {
    db,
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };
}
