/**
 * One throwaway Postgres for the whole db-store package, brought up by Testcontainers.
 *
 * BL1 says ship a cross-tenant leak suite. The failure mode of such a suite is not that it is
 * wrong -- it is that it does not run. The previous shape of `leak.test.ts` read DATABASE_URL and
 * `describe.runIf(hasDb)`'d itself away when it was missing, which means a green `pnpm test` on a
 * machine with no database proved nothing at all. So the suite now owns its database: no env
 * vars, no skip path, no way to be green by absence.
 *
 * Fresh per run, never persistent (#818): a shared dev container is attached to by every checkout
 * on the machine, and the leak suite is exactly the test you do not want reading someone else's
 * rows.
 *
 * Order is the same as src/migrate.ts, because the thing under test is the real init sequence:
 *   1. sql/00-roles.sql   as the container superuser -- creates mercatus_owner / mercatus_app
 *   2. drizzle-kit migrate as mercatus_owner         -- generated SQL, never hand-edited (J1)
 *   3. sql/02-rls.sql     as mercatus_owner          -- the policies actually being tested
 *
 * SABOTAGE, and why it lives here. A leak suite that has never been seen to fail is not evidence
 * (lesson 02). Setting
 *
 *     MERCATUS_LEAK_SABOTAGE=products
 *
 * replaces that one table's isolation policy with `using (true) with check (true)` after step 3
 * and before any test runs. The suite must go red. Anyone can re-run that experiment in one
 * command, which is the point -- it is the only proof that the green run means something.
 */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import type { TestProject } from 'vitest/node';

import { RLS_TABLES } from '../src/schema.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Pinned, and pinned to the version the policies were verified against (lesson 02: the
 * empty-string GUC behaviour and `force row level security` binding the owner were both confirmed
 * on 18.3). `:latest` would make an RLS regression look like a test flake.
 */
const IMAGE = 'postgres:18.3';

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

declare module 'vitest' {
  interface ProvidedContext {
    storeDb: StoreDbUrls;
  }
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

/**
 * Returns its own teardown rather than exporting one: vitest honours both shapes, and a default
 * export paired with a named `teardown` is the ambiguous combination. Verified by the line it
 * prints -- without it the container lingers until Ryuk reaps it, which is a race, not a cleanup.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let container: StartedPostgreSqlContainer | undefined;
  const started = Date.now();
  say(`db-store tests: starting ${IMAGE} (Testcontainers)`);
  container = await new PostgreSqlContainer(IMAGE)
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

  const sabotagedTable = process.env['MERCATUS_LEAK_SABOTAGE'] ?? null;
  if (sabotagedTable) await sabotage(adminUrl, sabotagedTable);

  project.provide('storeDb', { appUrl, adminUrl, superuserUrl, sabotagedTable });
  say(`db-store tests: database ready on ${hostPort} in ${String(Date.now() - started)}ms`);

  return async () => {
    // Leave the machine as we found it. Ryuk would get it eventually; do not make it wait.
    await container?.stop();
    container = undefined;
    say('db-store tests: database stopped');
  };
}
