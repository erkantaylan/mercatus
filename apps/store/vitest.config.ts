import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The suite owns its Postgres, migrated and RLS'd, from `@mercatus/db-store/testing`. It used
    // to read DATABASE_URL + DATABASE_ADMIN_URL and `describe.runIf` itself away, so a green
    // `pnpm -r test` hid 24 unexecuted tests -- including every licence-gate case (BL1).
    globalSetup: ['./test/global-setup.ts'],
    hookTimeout: 180_000,
    testTimeout: 60_000,
    // One database, shared by every file in this package; a serial run keeps counts readable.
    fileParallelism: false,
  },
});
