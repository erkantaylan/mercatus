/**
 * The composition root of the control plane.
 *
 * `auth: { adapter }` with no `tenants` and no `deployment` on purpose: this service has tenants
 * in a TABLE but no tenancy in its REQUESTS. There is no RLS here, no `app.tenant_id`, and no
 * per-request tenant decision to make -- an operator reads every tenant by design, and an
 * instance is scoped by the credential it presents, which auth.ts checks at the point of use.
 * Handing the hook a TenantDirectory would make it try to resolve a tenant from the URL of
 * `/tenants/acme`, which is the one place in this repo where a slug in a path is a query
 * parameter rather than a claim about who is asking.
 */
import type { MercatusServer } from '@mercatus/core';
import { createAuthAdapter, createServer } from '@mercatus/core';
import type { PlatformDbHandle } from '@mercatus/db-platform';

import { decoratePlatformPrincipal } from './auth.js';
import type { BankClient } from './bank.js';
import { createBankClient } from './bank.js';
import type { PlatformConfig } from './config.js';
import type { PlatformDeps } from './deps.js';
import { openDatabase, readVersion } from './deps.js';
import { IdentityProvisioner } from './identity.js';
import { createLicenceSigner } from './licence.js';
import { registerDevLoginRoutes } from './routes/dev-login.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerInstallationRoutes } from './routes/installations.js';
import { registerLicenceRoutes } from './routes/licences.js';
import { registerPaymentRoutes } from './routes/payments.js';
import { registerSignupRoute } from './routes/signup.js';
import { registerTelemetryRoutes } from './routes/telemetry.js';
import { registerTenantRoutes } from './routes/tenants.js';

export interface PlatformApp {
  readonly app: MercatusServer;
  readonly deps: PlatformDeps;
  close(): Promise<void>;
}

/**
 * The one seam for tests: a BankClient may be supplied instead of built. Nothing else is
 * injectable, because nothing else has an external dependency -- the database is real in the
 * test suite on purpose, since RLS-free or not, a control plane that only works against a mock
 * is a control plane nobody has run.
 */
export interface PlatformOverrides {
  readonly bank?: BankClient;
}

export async function buildPlatformApp(
  config: PlatformConfig,
  overrides: PlatformOverrides = {},
): Promise<PlatformApp> {
  const handle: PlatformDbHandle = openDatabase(config);

  const adapter = createAuthAdapter({
    adapter: config.authAdapter,
    ...(config.authStubSecret === undefined
      ? {}
      : { stub: { secret: config.authStubSecret, nodeEnv: config.nodeEnv } }),
  });

  const deps: PlatformDeps = {
    config,
    db: handle.db,
    adapter,
    bank:
      overrides.bank ??
      createBankClient({ baseUrl: config.fakeBankUrl, secret: config.fakeBankHmacSecret }),
    licences: await createLicenceSigner(config.licenceSigningKey),
    identity: new IdentityProvisioner(config),
    version: readVersion(),
  };

  const app = await createServer({
    name: '@mercatus/platform',
    version: deps.version,
    description: 'The control plane. Tenants, licences, installations and buy-a-store.',
    logLevel: config.logLevel,
    auth: { adapter },
  });

  decoratePlatformPrincipal(app);

  registerHealthRoutes(app, deps);
  registerSignupRoute(app, deps);
  registerPaymentRoutes(app, deps);
  registerTenantRoutes(app, deps);
  registerLicenceRoutes(app, deps);
  registerInstallationRoutes(app, deps);
  registerTelemetryRoutes(app, deps);
  registerDevLoginRoutes(app, deps);

  if (config.licenceKeysAreDevDefaults) {
    app.log.warn(
      { keyId: deps.licences.keyId() },
      'signing licences with the committed development key -- set LICENCE_SIGNING_KEY outside a laptop',
    );
  }

  return {
    app,
    deps,
    close: async () => {
      await app.close();
      await handle.close();
    },
  };
}
