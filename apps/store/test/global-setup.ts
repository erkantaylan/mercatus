/**
 * One throwaway data-plane Postgres for this package's suite, from `@mercatus/db-store/testing`.
 *
 * The same database the leak suite uses, brought up the same way, so the store API's tests run
 * against the real roles, the real migrations and the real policies -- and cannot skip.
 */
import type { StoreDbUrls } from '@mercatus/db-store/testing';
import { startStoreDatabase } from '@mercatus/db-store/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  interface ProvidedContext {
    storeDb: StoreDbUrls;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const started = await startStoreDatabase({ label: 'store tests' });
  project.provide('storeDb', started.urls);
  return started.stop;
}
