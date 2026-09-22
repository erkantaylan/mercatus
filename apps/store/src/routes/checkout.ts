/**
 * `POST /t/:slug/checkout` (BUILD-PLAN §6.2).
 *
 * The route is thin on purpose: placeOrder() already does the shopper upsert, the per-tenant
 * order number, the atomic stock decrement and the order with its lines -- in ONE transaction,
 * which is the one inTenantTx opened. Nothing here recomputes a total from the request: prices
 * come from the products table, because a posted price is a suggestion (§7.2).
 *
 * BI2 again: the tenant is the route's and the subject is the token's. The phone in the body is
 * contact information on the order, not an identity -- the subject is what the shopper is.
 *
 * The 402 for a passive licence belongs to the licence gate (CG3) and arrives with task 08. When
 * it does, it goes in front of this handler as a preHandler, not inside it.
 */
import {
  checkoutBodySchema,
  checkoutResultSchema,
  errorEnvelopeSchema,
  tenantSlugParamsSchema,
} from '@mercatus/contracts';
import type { MercatusServer, TenantContext } from '@mercatus/core';
import { requireShopper, UnauthenticatedError } from '@mercatus/core';
import { placeOrder } from '@mercatus/db-store';

import type { StoreDeps } from '../deps.js';
import { inTenantTx } from '../tx.js';

function subjectOf(ctx: TenantContext): string {
  if (!ctx.subject) throw new UnauthenticatedError(undefined, { logDetail: 'shopper context carries no subject' });
  return ctx.subject;
}

export function registerCheckoutRoute(app: MercatusServer, deps: StoreDeps): void {
  app.post(
    '/t/:slug/checkout',
    {
      preHandler: requireShopper(),
      schema: {
        summary: 'Place an order',
        tags: ['public'],
        security: [{ bearer: [] }],
        params: tenantSlugParamsSchema,
        body: checkoutBodySchema,
        response: {
          201: checkoutResultSchema,
          401: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
        },
      },
    },
    async (req, reply) => {
      const placed = await inTenantTx(deps, req, (tx, ctx) =>
        placeOrder(tx, ctx.tenantId, {
          shopper: {
            subject: subjectOf(ctx),
            phone: req.body.shopper.phone,
            name: req.body.shopper.name ?? null,
          },
          lines: req.body.lines,
        }),
      );
      reply.status(201);
      return placed;
    },
  );
}
