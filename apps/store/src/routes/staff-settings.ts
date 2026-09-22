/**
 * `/api/settings` and `/api/licence` -- what the dashboard shows about the store itself.
 *
 * `PATCH /api/settings` is NOT here, and that is deliberate rather than unfinished. `tenants` is
 * the one table without RLS, so the app role is granted SELECT on it and nothing else: an UPDATE
 * grant would be a cross-tenant WRITE surface on a table with no policy to scope it. The name and
 * branding are control-plane facts mirrored down (BV1), so the edit belongs on the control plane,
 * which then re-mirrors. Recorded in decisions-made-overnight.md for whoever builds task 07.
 *
 * `/api/licence` answers "what does this store believe, and why" -- status is the merchant's,
 * state is ours, and the dashboard shows a different banner for each (CG3).
 */
import { errorEnvelopeSchema, licenceViewSchema, settingsSchema } from '@mercatus/contracts';
import type { MercatusServer } from '@mercatus/core';
import { requireStaff, TenantNotFoundError } from '@mercatus/core';
import { findTenantById, readLicenceState } from '@mercatus/db-store';

import type { StoreDeps } from '../deps.js';
import { licenceClock, licenceView } from '../licence.js';
import { inTenantTx } from '../tx.js';

export function registerStaffSettingsRoutes(app: MercatusServer, deps: StoreDeps): void {
  app.get(
    '/api/settings',
    {
      preHandler: requireStaff(),
      schema: {
        summary: 'Store name and branding',
        tags: ['staff'],
        security: [{ bearer: [] }],
        response: { 200: settingsSchema, 401: errorEnvelopeSchema, 404: errorEnvelopeSchema },
      },
    },
    async (req) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new TenantNotFoundError();
      const row = await findTenantById(deps.db, ctx.tenantId);
      if (!row) throw new TenantNotFoundError();
      return { name: row.name, slug: row.slug, branding: row.branding };
    },
  );

  app.get(
    '/api/licence',
    {
      preHandler: requireStaff(),
      schema: {
        summary: 'What this store believes about its licence, and why',
        tags: ['staff'],
        security: [{ bearer: [] }],
        response: { 200: licenceViewSchema, 401: errorEnvelopeSchema },
      },
    },
    async (req) => {
      const row = await inTenantTx(deps, req, (tx) => readLicenceState(tx));
      return licenceView(row, licenceClock(deps.config));
    },
  );
}
