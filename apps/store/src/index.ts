/**
 * `apps/store` -- the data plane (BUILD-PLAN §6.2).
 *
 * The config is parsed before anything else happens, so a missing variable is a boot failure that
 * names the variable rather than a 500 in someone's basket (§8.2).
 */
import { loadStoreConfig } from '@mercatus/core';

import { buildStoreApp } from './app.js';

const config = loadStoreConfig();
const { app, close } = await buildStoreApp(config);

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { mode: config.mode, tenant: config.tenantSlug ?? null, adapter: config.authAdapter },
    'store listening',
  );
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  await close();
  process.exit(1);
}
