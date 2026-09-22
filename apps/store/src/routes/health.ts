/**
 * `/health` and `/_meta` (BUILD-PLAN §6.2).
 *
 * Neither needs a tenant, and neither needs a token -- they are what Aspire polls and what the
 * degradation demo curls. `/health` reports version and mode (CE6); `/_meta` adds the licence
 * state, which is the number the demo watches change when the control plane goes away (CG3).
 */
import { errorEnvelopeSchema, storeHealthSchema, storeMetaSchema } from '@mercatus/contracts';
import type { MercatusServer } from '@mercatus/core';
import { readLicenceState } from '@mercatus/db-store';

import type { StoreDeps } from '../deps.js';
import { licenceClock, licenceView } from '../licence.js';
import { inTenantTx } from '../tx.js';

export function registerHealthRoutes(app: MercatusServer, deps: StoreDeps): void {
  app.get(
    '/health',
    {
      schema: {
        summary: 'Liveness, build and deployment mode',
        tags: ['meta'],
        response: { 200: storeHealthSchema },
      },
    },
    () => ({
      status: 'ok' as const,
      version: deps.version,
      mode: deps.config.mode,
      tenant: deps.config.tenantSlug ?? null,
    }),
  );

  app.get(
    '/_meta',
    {
      schema: {
        summary: 'What this instance is and how its licence is behaving',
        tags: ['meta'],
        response: { 200: storeMetaSchema, 404: errorEnvelopeSchema },
      },
    },
    async (req) => {
      const clock = licenceClock(deps.config);
      const tenants = await deps.db.query.tenants.findMany();

      // Pooled, with no tenant named by the request, there is no single licence to report: the
      // process serves N merchants. Dedicated is the case the demo cares about, and there the
      // deployment pins the tenant, so a row is always in reach.
      const view = req.tenantContext
        ? licenceView(await inTenantTx(deps, req, (tx) => readLicenceState(tx)), clock)
        : licenceView(null, clock);

      return {
        mode: deps.config.mode,
        version: deps.version,
        tenantCount: tenants.length,
        licence: { status: view.status, state: view.state, lastSuccessAt: view.lastSuccessAt },
      };
    },
  );
}
