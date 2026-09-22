/**
 * The composition root. One image, two deployment modes, and NO second code path (CC1, CC2):
 * every route below is registered in both, and `DEPLOYMENT_MODE` changes only how the tenant is
 * resolved. A dedicated instance is this same process running as N=1.
 */
import type { MercatusServer, StoreConfig } from '@mercatus/core';
import { SessionIssuer, createAuthAdapter, createServer } from '@mercatus/core';
import type { StoreDbHandle } from '@mercatus/db-store';

import type { LicenceAgent } from './agents/licence-poll.js';
import { startLicenceAgent } from './agents/licence-poll.js';
import type { StoreDeps } from './deps.js';
import { openDatabase, readVersion, tenantDirectory } from './deps.js';
import { registerLicenceGate } from './plugins/licence-gate.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCheckoutRoute } from './routes/checkout.js';
import { registerDevLoginRoutes } from './routes/dev-login.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerPaymentRoutes } from './routes/payments.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerStaffOrderRoutes } from './routes/staff-orders.js';
import { registerStaffProductRoutes } from './routes/staff-products.js';
import { registerStaffSettingsRoutes } from './routes/staff-settings.js';

export interface StoreApp {
  readonly app: MercatusServer;
  readonly deps: StoreDeps;
  /** The outbound poll loop (CE4). Exposed so a test can drive one tick instead of waiting. */
  readonly licence: LicenceAgent;
  close(): Promise<void>;
}

export async function buildStoreApp(config: StoreConfig): Promise<StoreApp> {
  const handle: StoreDbHandle = openDatabase(config);
  const tenants = tenantDirectory(handle.db);

  const resolveTenantIdBySlug = async (slug: string): Promise<string | null> =>
    (await tenants.bySlug(slug))?.id ?? null;

  const adapter = createAuthAdapter({
    adapter: config.authAdapter,
    // CD4: exactly one issuer. Which one is a configuration choice, made once, here.
    ...(config.oidcIssuer
      ? {
          oidc: {
            issuer: config.oidcIssuer,
            cachePath: config.oidcJwksCachePath,
            resolveTenantIdBySlug,
            ...(config.oidcClientId === undefined ? {} : { clientId: config.oidcClientId }),
            ...(config.oidcClientSecret === undefined
              ? {}
              : { clientSecret: config.oidcClientSecret }),
          },
        }
      : {}),
    ...(config.authStubSecret === undefined
      ? {}
      : {
          stub: {
            secret: config.authStubSecret,
            nodeEnv: config.nodeEnv,
            // Lets a stub authorization code name a tenant by slug instead of by uuid. The
            // adapter cannot know the tenants table, and a hard-coded uuid per slug would put a
            // lie in the auth path.
            resolveTenantId: resolveTenantIdBySlug,
          },
        }),
  });

  const session = new SessionIssuer({
    secret: config.sessionSecret,
    ttlSeconds: config.sessionTtlSeconds,
    // Development is driven over http at 127.0.0.1, where a Secure cookie is simply dropped.
    secureCookie: config.nodeEnv !== 'development',
  });

  const deps: StoreDeps = {
    config,
    db: handle.db,
    adapter,
    session,
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
      session,
      tenants,
      deployment: {
        mode: config.mode,
        tenantSlug: config.tenantSlug,
        baseHost: config.baseHost,
      },
    },
  });

  // Before every route: the gate reads `config.licence` off the route it is about to run, so it
  // has to be registered before the routes declare it (CG3).
  registerLicenceGate(app, deps);

  registerHealthRoutes(app, deps);
  registerPublicRoutes(app, deps);
  registerCheckoutRoute(app, deps);
  registerPaymentRoutes(app, deps);
  registerStaffProductRoutes(app, deps);
  registerStaffOrderRoutes(app, deps);
  registerStaffSettingsRoutes(app, deps);
  registerAuthRoutes(app, deps);
  registerDevLoginRoutes(app, deps);

  // CE4: the data plane PULLS. Started after the routes so a tick can never race a half-built
  // application, and unref'd inside, so it never holds the process open by itself.
  const licence = startLicenceAgent(deps, app.log);

  return {
    app,
    deps,
    licence,
    close: async () => {
      licence.stop();
      await app.close();
      await handle.close();
    },
  };
}
