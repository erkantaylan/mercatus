/**
 * What every route needs, assembled once at boot and passed by closure. No container, no
 * injection -- the composition root in app.ts is the only place that knows how these are built.
 */
import { readFileSync } from 'node:fs';

import type { AuthAdapter } from '@mercatus/core';
import type { PlatformDb, PlatformDbHandle } from '@mercatus/db-platform';
import { createPlatformDb } from '@mercatus/db-platform';

import type { BankClient } from './bank.js';
import type { PlatformConfig } from './config.js';
import type { LicenceSigner } from './licence.js';

export interface PlatformDeps {
  readonly config: PlatformConfig;
  readonly db: PlatformDb;
  /** Wired for the Identity phase. The control plane's own credentials are in auth.ts. */
  readonly adapter: AuthAdapter;
  readonly bank: BankClient;
  readonly licences: LicenceSigner;
  readonly version: string;
}

export function readVersion(): string {
  const url = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: string };
  return pkg.version ?? '0.0.0';
}

export function openDatabase(config: PlatformConfig): PlatformDbHandle {
  // The app role. A server process never holds the owner's connection string (BE2), even here
  // where there is no RLS to disable -- the runtime role creates nothing and owns nothing.
  return createPlatformDb(config.databaseUrl, { max: 10 });
}
