/**
 * The control-plane init step. Same shape as db-store's, minus the RLS:
 *   1. sql/00-roles.sql    as the superuser
 *   2. drizzle-kit migrate as the owner
 *   3. sql/02-grants.sql   as the owner
 *   4. src/seed.ts         as the owner, only with --seed
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

async function runSqlFile(url: string, relativePath: string): Promise<void> {
  const text = await readFile(join(packageRoot, relativePath), 'utf8');
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    // .simple() -- the extended protocol allows one statement per round trip; a .sql file is many.
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
  if (result.status !== 0) throw new Error(`drizzle-kit migrate exited ${String(result.status)}`);
}

async function main(): Promise<void> {
  const adminUrl = process.env['DATABASE_ADMIN_URL'];
  if (!adminUrl) throw new Error('DATABASE_ADMIN_URL is not set (BUILD-PLAN §8.2).');
  const superuserUrl = process.env['DATABASE_SUPERUSER_URL'] ?? adminUrl;

  say('db-platform: roles');
  await runSqlFile(superuserUrl, 'sql/00-roles.sql');

  say('db-platform: migrations');
  runDrizzleKit(adminUrl);

  say('db-platform: grants');
  await runSqlFile(adminUrl, 'sql/02-grants.sql');

  if (process.argv.includes('--seed')) {
    say('db-platform: seed');
    const { seed } = await import('./seed.js');
    await seed(adminUrl);
  }

  say('db-platform: done');
}

await main();
