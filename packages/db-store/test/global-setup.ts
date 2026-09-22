/**
 * One throwaway Postgres for the whole db-store package, brought up by Testcontainers.
 *
 * BL1 says ship a cross-tenant leak suite. The failure mode of such a suite is not that it is
 * wrong -- it is that it does not run. The previous shape of `leak.test.ts` read DATABASE_URL and
 * `describe.runIf(hasDb)`'d itself away when it was missing, which means a green `pnpm test` on a
 * machine with no database proved nothing at all. So the suite owns its database: no env vars, no
 * skip path, no way to be green by absence. The mechanics live in `./harness.ts`, because
 * `apps/store` and `apps/platform` had exactly the same hole and now use the same shape.
 *
 * SABOTAGE, and why it lives here. A leak suite that has never been seen to fail is not evidence
 * (lesson 02). Setting
 *
 *     MERCATUS_LEAK_SABOTAGE=products
 *
 * replaces that one table's isolation policy with `using (true) with check (true)` after the RLS
 * file and before any test runs. The suite must go red. Anyone can re-run that experiment in one
 * command, which is the point -- it is the only proof that the green run means something.
 */
import type { TestProject } from 'vitest/node';

import type { StoreDbUrls } from './harness.js';
import { startStoreDatabase } from './harness.js';

declare module 'vitest' {
  interface ProvidedContext {
    storeDb: StoreDbUrls;
  }
}

/**
 * Returns its own teardown rather than exporting one: vitest honours both shapes, and a default
 * export paired with a named `teardown` is the ambiguous combination. Verified by the line it
 * prints -- without it the container lingers until Ryuk reaps it, which is a race, not a cleanup.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const started = await startStoreDatabase({
    label: 'db-store tests',
    sabotagedTable: process.env['MERCATUS_LEAK_SABOTAGE'] ?? null,
  });
  project.provide('storeDb', started.urls);
  return started.stop;
}
