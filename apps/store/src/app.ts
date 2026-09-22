/**
 * The composition root. One image, two deployment modes, and NO second code path (CC1, CC2):
 * every route below is registered in both, and `DEPLOYMENT_MODE` changes only how the tenant is
 * resolved. A dedicated instance is this same process running as N=1.
 */
import type { MercatusServer, StoreConfig } from '@mercatus/core';
import { createAuthAdapter, createServer } from '@mercatus/core';
import type { StoreDbHandle } from '@mercatus/db-store';

import type { StoreDeps } from './deps.js';
import { openDatabase, readVersion, tenantDirectory } from './deps.js';
import { registerCheckoutRoute } from './routes/checkout.js';
import { registerDevLoginRoutes } from './routes/dev-login.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerStaffOrderRoutes } from './routes/staff-orders.js';
import { registerStaffProductRoutes } from './routes/staff-products.js';
import { registerStaffSettingsRoutes } from './routes/staff-settings.js';

export interface StoreApp {
  readonly app: MercatusServer;
  readonly deps: StoreDeps;
  close(): Promise<void>;
}

export async function buildStoreApp(config: StoreConfig): Promise<StoreApp> {
  const handle: StoreDbHandle = openDatabase(config);
  const tenants = tenantDirectory(handle.db);

  const adapter = createAuthAdapter({
    adapter: config.authAdapter,
    ...(config.authStubSecret === undefined
      ? {}
      : {
          stub: {
            secret: config.authStubSecret,
            nodeEnv: config.nodeEnv,
            // Lets a stub authorization code name a tenant by slug instead of by uuid. The
            // adapter cannot know the tenants table, and a hard-coded uuid per slug would put a
            // lie in the auth path.
            resolveTenantId: async (slug: string) => (await tenants.bySlug(slug))?.id ?? null,
          },
        }),
  });

  const deps: StoreDeps = {
    config,
    db: handle.db,
    adapter,
    version: readVersion(),
    tenants,
  };

  const app = await createServer({
    name: '@mercatus/store',
    version: deps.version,
    description: 'The data plane. Products, checkout and orders for one tenant at a time.',
    logLevel: config.logLevel,
    auth: {
      adapter,
      tenants,
      deployment: {
        mode: config.mode,
        tenantSlug: config.tenantSlug,
        baseHost: config.baseHost,
      },
    },
  });

  registerHealthRoutes(app, deps);
  registerPublicRoutes(app, deps);
  registerCheckoutRoute(app, deps);
  registerStaffProductRoutes(app, deps);
  registerStaffOrderRoutes(app, deps);
  registerStaffSettingsRoutes(app, deps);
  registerDevLoginRoutes(app, deps);

  return {
    app,
    deps,
    close: async () => {
      await app.close();
      await handle.close();
    },
  };
}
