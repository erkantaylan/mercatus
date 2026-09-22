import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The suite owns its Postgres. It used to read PLATFORM_DATABASE_URL and skip itself when
    // that was absent, which meant `pnpm -r test` reported "Tests 22 skipped (22)" -- the entire
    // control plane, green, every run (BL1's failure mode).
    globalSetup: ['./test/global-setup.ts'],
    // Pulling an image the first time is slow; starting a cached one is ~2s.
    hookTimeout: 180_000,
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
