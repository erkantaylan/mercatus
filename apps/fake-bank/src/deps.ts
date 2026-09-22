import { readFileSync } from 'node:fs';

import type { FakeBankConfig } from './config.js';
import type { PaymentStore } from './store.js';

export interface FakeBankDeps {
  readonly config: FakeBankConfig;
  readonly payments: PaymentStore;
  readonly version: string;
}

/** CE6 in miniature: a build that cannot say what it is has nothing useful to report. */
export function readVersion(): string {
  const url = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: string };
  return pkg.version ?? '0.0.0';
}
