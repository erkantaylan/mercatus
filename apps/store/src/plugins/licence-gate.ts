/**
 * The licence gate (CG3, CG1, BUILD-PLAN §6.2).
 *
 * Four states, four behaviours, and the whole point of the file is that they are FOUR and not
 * two:
 *
 *   healthy    everything works.
 *   passive    the tenant's own state. Checkout is refused with 402 and the dashboard is
 *              untouched -- every staff route, read and write, keeps answering, because the page
 *              that fixes a passive licence is the last thing you take away from someone who
 *              owes you money.
 *   grace      we could not be reached and the window we wrote down has not expired. NOTHING is
 *              refused. This is the state the flagship demo spends its time in.
 *   read_only  we could not be reached for longer than that. Browse and read still work;
 *              checkout and every write answer 503. Degraded, never a hard stop (CG1).
 *
 * The two reasons are two error codes -- `LICENCE_PASSIVE` (402) and `CONTROL_PLANE_UNREACHABLE`
 * (503) -- so a client can say a different sentence for each. Collapsing them would make our
 * outage look to a merchant exactly like being cut off for non-payment.
 *
 * A route opts in by declaring `config: { licence: 'checkout' | 'write' }`. Nothing is gated by
 * guessing from the HTTP verb: a gate you have to read the router to find is a gate somebody
 * adds a route around.
 */
import type { MercatusServer } from '@mercatus/core';
import { ControlPlaneUnreachableError, LicencePassiveError } from '@mercatus/core';
import { readLicenceState } from '@mercatus/db-store';

import type { StoreDeps } from '../deps.js';
import { checkoutBlock, licenceClock, licenceView, writesRefused } from '../licence.js';
import { inTenantTx } from '../tx.js';

/** What a route is asking the licence about. Absent means "a read", which is never refused. */
export type LicenceGate = 'checkout' | 'write';

declare module 'fastify' {
  interface FastifyContextConfig {
    licence?: LicenceGate;
  }
}

export function registerLicenceGate(app: MercatusServer, deps: StoreDeps): void {
  const clock = licenceClock(deps.config);

  // preHandler, not onRequest: the tenant context is established by the auth hook and the gate
  // needs it, both to know which tenant's licence to read and to open the transaction that RLS
  // scopes. A request with no tenant is not gated here -- the route itself refuses it.
  app.addHook('preHandler', async (req) => {
    const gate = req.routeOptions.config.licence;
    if (!gate) return;
    if (!req.tenantContext) return;

    const view = licenceView(await inTenantTx(deps, req, (tx) => readLicenceState(tx)), clock);

    if (gate === 'checkout') {
      const block = checkoutBlock(view);
      if (block === 'passive') {
        throw new LicencePassiveError(undefined, {
          logDetail: `tenant ${req.tenantContext.tenantId} is passive; checkout refused (CG3)`,
        });
      }
      if (block === 'unreachable') {
        throw new ControlPlaneUnreachableError(undefined, {
          logDetail: `control plane last reached ${view.lastSuccessAt ?? 'never'}; past the grace window`,
        });
      }
      return;
    }

    if (writesRefused(view)) {
      throw new ControlPlaneUnreachableError('Changes are paused until the platform is reachable.', {
        logDetail: `control plane last reached ${view.lastSuccessAt ?? 'never'}; writes refused (CG1)`,
      });
    }
  });
}
