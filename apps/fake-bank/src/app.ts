/**
 * The composition root.
 *
 * `createServer` is called with NO `auth` block. fake-bank has no tenants and no tokens: the only
 * thing it authenticates is the HMAC on a request body, which happens in the route because it is
 * a property of the payload rather than of the caller. `AuthContextOptions` already documents
 * this case ("Omitted by a service with no tenants of its own"), so nothing in @mercatus/core
 * needed changing.
 */
import type { MercatusServer } from '@mercatus/core';
import { createServer } from '@mercatus/core';

import type { FakeBankConfig } from './config.js';
import type { FakeBankDeps } from './deps.js';
import { readVersion } from './deps.js';
import { registerHealthRoute } from './routes/health.js';
import { registerPaymentRoutes } from './routes/payments.js';
import { registerPayRoutes } from './routes/pay.js';
import { createPaymentStore } from './store.js';

export interface FakeBankApp {
  readonly app: MercatusServer;
  readonly deps: FakeBankDeps;
  close(): Promise<void>;
}

export async function buildFakeBankApp(config: FakeBankConfig): Promise<FakeBankApp> {
  const deps: FakeBankDeps = {
    config,
    payments: createPaymentStore(),
    version: readVersion(),
  };

  const app = await createServer({
    name: '@mercatus/fake-bank',
    version: deps.version,
    description:
      'A payment provider we control. It verifies our signature before answering, signs its ' +
      'callback, and can be told to approve, decline, sign badly, stay silent or drop the ' +
      'connection (CR1). Run-mode only; it never ships.',
    logLevel: config.logLevel,
  });

  registerHealthRoute(app, deps);
  registerPaymentRoutes(app, deps);
  registerPayRoutes(app, deps);

  return {
    app,
    deps,
    close: async () => {
      await app.close();
    },
  };
}
