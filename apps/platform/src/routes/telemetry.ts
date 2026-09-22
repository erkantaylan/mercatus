/**
 * `POST /telemetry/heartbeat` (BUILD-PLAN §6.1, CE6, CE3, CI1).
 *
 * Every data plane reports its version, its tenant and its licence id on every batch, because
 * version skew is invisible until you can query it. The counts come along for the console.
 *
 * WHAT IS NOT ACCEPTED HERE: anything about a person. No shopper, no phone number, no order
 * contents. What you collect from someone else's server is a legal artifact, not just an ops
 * feature (CI1), and the contract enforces it -- `heartbeatBodySchema` names five scalar fields
 * and a body carrying a sixth is a 400, not a silently-stored surprise.
 *
 * The numbers are TELEMETRY, not metering (CE3). The customer has root on that box and can edit
 * them; limits are enforced through the signed licence, which they cannot.
 */
import { errorEnvelopeSchema, heartbeatBodySchema } from '@mercatus/contracts';
import type { MercatusServer } from '@mercatus/core';
import { ForbiddenError } from '@mercatus/core';
import { recordHeartbeat } from '@mercatus/db-platform';
import { z } from 'zod';

import { requireInstance } from '../auth.js';
import type { PlatformDeps } from '../deps.js';

export function registerTelemetryRoutes(app: MercatusServer, deps: PlatformDeps): void {
  app.post(
    '/telemetry/heartbeat',
    {
      preHandler: requireInstance(deps),
      schema: {
        summary: 'A dedicated instance reports what it is and how much of it there is',
        tags: ['installations'],
        security: [{ bearer: [] }],
        body: heartbeatBodySchema,
        response: { 204: z.null(), 401: errorEnvelopeSchema, 403: errorEnvelopeSchema },
      },
    },
    async (req, reply) => {
      const principal = req.platformPrincipal;
      if (principal?.kind !== 'instance') throw new ForbiddenError();

      // The instance credential decides which installation this is. The tenant id in the body is
      // checked against it rather than trusted: a box may report about itself and nothing else.
      if (req.body.tenantId !== principal.tenantId) {
        throw new ForbiddenError(undefined, {
          logDetail: `installation ${principal.installationId} reported tenant ${req.body.tenantId}, but is registered to ${principal.tenantId}`,
        });
      }

      await recordHeartbeat(deps.db, {
        id: principal.installationId,
        version: req.body.version,
        licenceId: req.body.licenceId,
        productCount: req.body.productCount,
        orderCount: req.body.orderCount,
      });

      req.log.info(
        {
          installationId: principal.installationId,
          version: req.body.version,
          licenceId: req.body.licenceId,
        },
        'heartbeat',
      );
      await reply.status(204).send(null);
      return;
    },
  );
}
