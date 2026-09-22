/**
 * `apps/fake-bank` -- the payment stand-in (BUILD-PLAN §6.3, CR1).
 *
 * Refuses to start without `MERCATUS_ALLOW_FAKE_BANK=1`. Only the AppHosts set it, and the guard
 * is in the config schema so it fails at boot with the name of the variable rather than as a
 * surprise endpoint somewhere it should not exist.
 */
import { loadFakeBankConfig } from './config.js';
import { buildFakeBankApp } from './app.js';

const config = loadFakeBankConfig();
const { app, close } = await buildFakeBankApp(config);

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info({ port: config.port }, 'fake-bank listening -- run mode only, no money moves here');
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  await close();
  process.exit(1);
}
