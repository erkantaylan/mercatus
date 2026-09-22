import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    // Pulling an image the first time is slow; starting a cached one is ~2s. The hook timeout
    // covers the first run on a cold machine.
    hookTimeout: 180_000,
    testTimeout: 60_000,
    // One database, shared by every file in this package. The suites seed their own tenants, so
    // they do not collide -- but a serial run keeps a failure's row counts readable.
    fileParallelism: false,
  },
});
