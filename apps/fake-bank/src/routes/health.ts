import { healthSchema } from '@mercatus/contracts';
import type { MercatusServer } from '@mercatus/core';

import type { FakeBankDeps } from '../deps.js';

export function registerHealthRoute(app: MercatusServer, deps: FakeBankDeps): void {
  app.get(
    '/health',
    {
      schema: {
        summary: 'Liveness',
        tags: ['meta'],
        response: { 200: healthSchema },
      },
    },
    () => ({ status: 'ok' as const, version: deps.version }),
  );
}
