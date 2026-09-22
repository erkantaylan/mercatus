/**
 * `apps/platform` -- the control plane (BUILD-PLAN §6.1).
 *
 * The config is parsed before anything else happens, so a missing variable is a boot failure that
 * names the variable rather than a 500 in the middle of someone buying a store (§8.2).
 */
import { buildPlatformApp } from './app.js';
import { loadPlatformConfig } from './config.js';

const config = loadPlatformConfig();
const { app, close } = await buildPlatformApp(config);

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
    { adapter: config.authAdapter, bank: config.fakeBankUrl, self: config.platformUrl },
    'platform listening',
  );
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  await close();
  process.exit(1);
}
