/**
 * `/health` (BUILD-PLAN §6.1). No token, no tenant -- it is what Aspire polls.
 *
 * The control plane's health is `{ status, version }` and nothing more. The DATA plane's says
 * more because a box on someone else's server has to be able to state what it is (CE6); this
 * process is ours, and what it is running is already on every log line.
 */
import { healthSchema } from '@mercatus/contracts';
import type { MercatusServer } from '@mercatus/core';

import type { PlatformDeps } from '../deps.js';

export function registerHealthRoutes(app: MercatusServer, deps: PlatformDeps): void {
  app.get(
    '/health',
    {
      schema: {
        summary: 'Liveness and build',
        tags: ['meta'],
        response: { 200: healthSchema },
      },
    },
    () => ({ status: 'ok' as const, version: deps.version }),
  );
}
