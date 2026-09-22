/**
 * The end-to-end suite (BUILD-PLAN §9, task 11). It drives the REAL Chrome on this machine and it
 * asserts the demo, because the demo is the acceptance criteria.
 *
 * It starts NOTHING. The stack is two `aspire run --detach` commands (README "Running it"), and a
 * Playwright `webServer` block would be a third, competing, way to bring up a topology that Aspire
 * already owns. `globalSetup` refuses to run the suite against a stack that is not up, and says
 * which command is missing rather than failing thirty tests on connection refused.
 *
 * Serial, one worker, no retries: every spec moves shared state a real operator would move -- a
 * licence flipped to passive, a control-plane process killed -- and two of those at once is not a
 * test, it is a race. Retries would hide exactly the flakiness worth seeing.
 */
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

/** Screenshots and traces land at the REPO ROOT, so the morning's evidence is in one obvious place. */
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig({
  testDir: './tests',
  outputDir: `${repoRoot}test-results`,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // A grace window is 60 seconds here (LICENCE_GRACE_SECONDS), and one test sits through part of
  // one. Next's dev server also compiles a route on first request, which is seconds, once.
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { outputFolder: `${repoRoot}playwright-report`, open: 'never' }]],
  globalSetup: './tests/helpers/global-setup.ts',
  use: {
    ...devices['Desktop Chrome'],
    // The real browser, not a downloaded bundle: `channel: 'chrome'` launches
    // /usr/bin/google-chrome. `pnpm install` never downloads a browser (pnpm-workspace.yaml
    // refuses playwright's postinstall), so this is the only thing that can drive the suite.
    channel: 'chrome',
    headless: true,
    viewport: { width: 1360, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chrome' }],
});
