/**
 * A throwaway, fully migrated control-plane Postgres, owned by whoever asks for it.
 *
 * Exported as `@mercatus/db-platform/testing` so `apps/platform`'s suite uses it. It exists for
 * one reason: that suite used to be `describe.skipIf(!hasDb)` on PLATFORM_DATABASE_URL, so
 * `pnpm -r test` reported `Tests 22 skipped (22)` -- the ENTIRE control plane, every run, green.
 * A suite that owns its database has no skip path to be green through (BL1's failure mode, one
 * package over).
 *
 * Same order as src/migrate.ts, minus the RLS this database does not have:
 *   1. sql/00-roles.sql    as the container superuser
 *   2. drizzle-kit migrate as mercatus_platform_owner
 *   3. sql/02-grants.sql   as the owner
 */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

/** The version everything else in this repo is pinned to. */
export const PLATFORM_IMAGE = 'postgres:18.3';

/** Literals from sql/00-roles.sql. A container that exists for a minute holds no secret. */
const OWNER_DSN = 'mercatus_platform_owner:mercatus_platform_owner_dev';
const APP_DSN = 'mercatus_platform_app:mercatus_platform_app_dev';

export interface PlatformDbUrls {
  /** mercatus_platform_app -- the runtime role. The API under test connects as this. */
  readonly appUrl: string;
  /** mercatus_platform_owner -- owns the schema. Migrations, grants, fixtures. */
  readonly adminUrl: string;
  readonly superuserUrl: string;
}

export interface StartedPlatformDb {
  readonly urls: PlatformDbUrls;
  stop(): Promise<void>;
}

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** `.simple()` -- the extended protocol allows one statement per round trip; a .sql file is many. */
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
  const bin = join(packageRoot, 'node_modules', '.bin', 'drizzle-kit');
  const result = spawnSync(bin, ['migrate'], {
    cwd: packageRoot,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_ADMIN_URL: adminUrl, PLATFORM_DATABASE_ADMIN_URL: adminUrl },
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`drizzle-kit migrate exited ${String(result.status)}`);
}

export interface StartPlatformDbOptions {
  readonly label?: string;
  /** Seed the two pooled tenants and the unspent dedicated installation. */
  readonly seed?: boolean;
}

export async function startPlatformDatabase(
  options: StartPlatformDbOptions = {},
): Promise<StartedPlatformDb> {
  const label = options.label ?? 'platform db';
  const started = Date.now();
  say(`${label}: starting ${PLATFORM_IMAGE} (Testcontainers)`);
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(PLATFORM_IMAGE)
    .withDatabase('platform')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();

  const hostPort = `${container.getHost()}:${String(container.getPort())}`;
  const superuserUrl = container.getConnectionUri();
  const adminUrl = `postgres://${OWNER_DSN}@${hostPort}/platform`;
  const appUrl = `postgres://${APP_DSN}@${hostPort}/platform`;

  await runSqlFile(superuserUrl, 'sql/00-roles.sql');
  runDrizzleKit(adminUrl);
  await runSqlFile(adminUrl, 'sql/02-grants.sql');

  if (options.seed === true) {
    const { seed } = await import('../src/seed.js');
    await seed(adminUrl);
  }

  say(`${label}: database ready on ${hostPort} in ${String(Date.now() - started)}ms`);

  return {
    urls: { appUrl, adminUrl, superuserUrl },
    stop: async () => {
      await container.stop();
      say(`${label}: database stopped`);
    },
  };
}
