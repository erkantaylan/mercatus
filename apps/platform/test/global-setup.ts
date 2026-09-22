/**
 * One throwaway control-plane Postgres for this package's suite, from
 * `@mercatus/db-platform/testing`.
 *
 * No environment variable decides whether these tests run. That is the entire point: this suite
 * was `describe.skipIf(!hasDb)` and therefore reported 22 skipped tests inside a green
 * `pnpm -r test`, which is indistinguishable from a control plane nobody exercises.
 */
import type { PlatformDbUrls } from '@mercatus/db-platform/testing';
import { startPlatformDatabase } from '@mercatus/db-platform/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  interface ProvidedContext {
    platformDb: PlatformDbUrls;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  // Seeded: two of the cases below are about a POOLED tenant (installations are refused for
  // one, and an instance credential may not read one), and `acme` is what the seed calls it.
  const started = await startPlatformDatabase({ label: 'platform tests', seed: true });
  project.provide('platformDb', started.urls);
  return started.stop;
}
