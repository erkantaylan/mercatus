/**
 * A throwaway, fully migrated data-plane Postgres, owned by whoever asks for it.
 *
 * Exported as `@mercatus/db-store/testing` so the STORE's own suites use the same one. That is
 * the whole point: the failure mode of a leak suite is not that it is wrong, it is that it does
 * not run (BL1). `apps/store` used to read DATABASE_URL and `describe.runIf(hasDb)` itself away,
 * so `pnpm -r test` was green with 24 of its tests never executed -- the licence gate among them.
 * A suite that owns its database has no skip path to be green through.
 *
 * Fresh per call, never persistent (#818): a shared dev container is attached to by every
 * checkout on the machine.
 *
 * Order is the same as src/migrate.ts, because the thing under test is the real init sequence:
 *   1. sql/00-roles.sql   as the container superuser -- creates mercatus_owner / mercatus_app
 *   2. drizzle-kit migrate as mercatus_owner         -- generated SQL, never hand-edited (J1)
 *   3. sql/02-rls.sql     as mercatus_owner          -- the policies actually being tested
 */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';

import { RLS_TABLES } from '../src/schema.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Pinned, and pinned to the version the policies were verified against (lesson 02: the
 * empty-string GUC behaviour and `force row level security` binding the owner were both confirmed
 * on 18.3). `:latest` would make an RLS regression look like a test flake.
 */
export const STORE_IMAGE = 'postgres:18.3';

/** Literals from sql/00-roles.sql. A container that exists for ninety seconds holds no secret. */
const OWNER_DSN = 'mercatus_owner:mercatus_owner_dev';
const APP_DSN = 'mercatus_app:mercatus_app_dev';

export interface StoreDbUrls {
  /** mercatus_app -- LOGIN, NOBYPASSRLS. Everything under test connects as this (BE2). */
  readonly appUrl: string;
  /** mercatus_owner -- owns the schema. Fixtures and cleanup only. */
  readonly adminUrl: string;
  /** The container's own superuser. Roles and nothing else. */
  readonly superuserUrl: string;
  /** The table whose policy was deliberately broken, when the suite is being proved. */
  readonly sabotagedTable: string | null;
}

export interface StartedStoreDb {
  readonly urls: StoreDbUrls;
  stop(): Promise<void>;
}

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * postgres.js uses the extended protocol, which allows one statement per round trip, so a .sql
 * file fails. `.simple()` switches protocols and takes the whole file, DO blocks included.
 */
async function runSqlFile(url: string, relativePath: string): Promise<void> {
  const text = await readFile(join(packageRoot, relativePath), 'utf8');
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client.unsafe(text).simple();
  } finally {
    await client.end({ timeout: 5 });
  }
}

function runDrizzleKit(adminUrl: string): void {
  // Resolved rather than found on PATH: global setup does not necessarily inherit the package's
  // node_modules/.bin, and "drizzle-kit: not found" three layers down is a bad error.
  const bin = join(packageRoot, 'node_modules', '.bin', 'drizzle-kit');
  const result = spawnSync(bin, ['migrate'], {
    cwd: packageRoot,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_ADMIN_URL: adminUrl },
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`drizzle-kit migrate exited ${String(result.status)}`);
}

/**
 * Swap one table's isolation policy for an open one. Deliberately NOT
 * `disable row level security`: leaving RLS enabled and forced means the coverage assertions stay
 * green and only the leak assertions go red, which is what proves the leak assertions are the
 * ones doing the work.
 */
async function sabotage(adminUrl: string, table: string): Promise<void> {
  const known = RLS_TABLES as readonly string[];
  if (!known.includes(table)) {
    throw new Error(`MERCATUS_LEAK_SABOTAGE=${table} is not an RLS table. One of: ${known.join(', ')}`);
  }
  const client = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await client
      .unsafe(
        `drop policy if exists ${table}_tenant_isolation on ${table};
         create policy ${table}_sabotaged on ${table} using (true) with check (true);`,
      )
      .simple();
  } finally {
    await client.end({ timeout: 5 });
  }
  say(`\n  !! SABOTAGE: ${table}_tenant_isolation replaced with using(true). The suite MUST go red.\n`);
}

export interface StartStoreDbOptions {
  /** Prefix for the "database ready" line, so two suites in one run are distinguishable. */
  readonly label?: string;
  /** Break one table's policy on purpose. Only the leak suite passes this (MERCATUS_LEAK_SABOTAGE). */
  readonly sabotagedTable?: string | null;
}

export async function startStoreDatabase(options: StartStoreDbOptions = {}): Promise<StartedStoreDb> {
  const label = options.label ?? 'store db';
  const started = Date.now();
  say(`${label}: starting ${STORE_IMAGE} (Testcontainers)`);
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(STORE_IMAGE)
    .withDatabase('store')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();

  const hostPort = `${container.getHost()}:${String(container.getPort())}`;
  const superuserUrl = container.getConnectionUri();
  const adminUrl = `postgres://${OWNER_DSN}@${hostPort}/store`;
  const appUrl = `postgres://${APP_DSN}@${hostPort}/store`;

  await runSqlFile(superuserUrl, 'sql/00-roles.sql');
  runDrizzleKit(adminUrl);
  await runSqlFile(adminUrl, 'sql/02-rls.sql');

  const sabotagedTable = options.sabotagedTable ?? null;
  if (sabotagedTable) await sabotage(adminUrl, sabotagedTable);

  say(`${label}: database ready on ${hostPort} in ${String(Date.now() - started)}ms`);

  return {
    urls: { appUrl, adminUrl, superuserUrl, sabotagedTable },
    stop: async () => {
      // Leave the machine as we found it. Ryuk would get it eventually; do not make it wait.
      await container.stop();
      say(`${label}: database stopped`);
    },
  };
}
