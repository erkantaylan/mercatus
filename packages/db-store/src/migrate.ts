/**
 * The data-plane init step (BUILD-PLAN §5.3). Never runs in-process inside a server: migrations
 * are an ordered, observable step with its own exit code.
 *
 * Order, and it matters:
 *   1. sql/00-roles.sql      as the superuser  -- the roles must exist before anything is granted
 *   2. drizzle-kit migrate   as the owner      -- generated SQL, never hand-edited (J1)
 *   3. sql/02-rls.sql        as the owner      -- policies and grants
 *   4. src/seed.ts           as the owner      -- only with --seed
 *
 * Usage:
 *   DATABASE_SUPERUSER_URL=... DATABASE_ADMIN_URL=... pnpm --filter @mercatus/db-store migrate
 *   ... migrate --seed
 */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (BUILD-PLAN §8.2).`);
  return value;
}

/**
 * postgres.js uses the extended protocol by default, which allows exactly one statement per
 * round trip. `.simple()` switches to the simple protocol, which is what lets a whole .sql file
 * -- DO blocks and all -- go over in one call.
 */
async function runSqlFile(url: string, relativePath: string): Promise<void> {
  const text = await readFile(join(packageRoot, relativePath), 'utf8');
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client.unsafe(text).simple();
    say(`  ok  ${relativePath}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

function runDrizzleKit(adminUrl: string): void {
  const result = spawnSync('drizzle-kit', ['migrate'], {
    cwd: packageRoot,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_ADMIN_URL: adminUrl },
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`drizzle-kit migrate exited ${String(result.status)}`);
  }
}

async function main(): Promise<void> {
  const adminUrl = required('DATABASE_ADMIN_URL');
  // Creating a role needs a connection that can create roles. When the admin connection already
  // is one -- the usual case with an Aspire-provisioned Postgres -- it does double duty.
  const superuserUrl = process.env['DATABASE_SUPERUSER_URL'] ?? adminUrl;

  say('db-store: roles');
  await runSqlFile(superuserUrl, 'sql/00-roles.sql');

  say('db-store: migrations');
  runDrizzleKit(adminUrl);

  say('db-store: rls');
  await runSqlFile(adminUrl, 'sql/02-rls.sql');

  if (process.argv.includes('--seed')) {
    say('db-store: seed');
    const { seed } = await import('./seed.js');
    await seed(adminUrl);
  }

  say('db-store: done');
}

await main();
