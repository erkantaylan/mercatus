/**
 * `POST /t/:slug/orders/:id/payment` -- the settlement, written where the merchant can see it.
 *
 * The defect this closes: a completed purchase was indistinguishable from an abandoned one in the
 * dashboard. The bank settled, the callback was delivered and verified, and the only record of it
 * was a `Map` in the storefront's Node process -- lost on restart, absent from every database,
 * and never shown to the merchant. "Did this order get paid" is the one question a merchant
 * dashboard exists to answer.
 *
 * The caller asserts NOTHING. It hands over a payment id; this route asks the bank itself and
 * accepts the answer only if that payment's own `reference` names this order and its amount
 * matches the order total. So the route needs no credential and -- the part that matters --
 * no shared bank HMAC secret on a box whose owner has root (CE2, CE5). The bank is the authority
 * on whether money moved; a store is only allowed to read it.
 *
 * Every arrow is still outbound from the data plane (CE4): we call the bank, the bank never has
 * to call us, and nothing is pushed into anyone's network.
 *
 * It is idempotent (CK2): the same settlement posted twice writes the same row twice.
 */
import {
  errorEnvelopeSchema,
  settleOrderPaymentBodySchema,
  settleOrderPaymentResultSchema,
  tenantResourceParamsSchema,
} from '@mercatus/contracts';
import type { MercatusServer } from '@mercatus/core';
import { ConflictError, NotFoundError } from '@mercatus/core';
import { findOrderById, recordSettlement } from '@mercatus/db-store';
import { z } from 'zod';

import type { StoreDeps } from '../deps.js';
import { inTenantTx } from '../tx.js';

/**
 * fake-bank's payment, as much of it as this route believes. Declared here rather than imported:
 * `apps/fake-bank` is an application and is run-mode only, so nothing may depend on it (CR1). Its
 * shape is in `apps/fake-bank/src/contracts.ts` and in lessons/04b.
 */
const bankPaymentSchema = z.object({
  id: z.uuid(),
  providerRef: z.string().min(1),
  reference: z.string().min(1),
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  status: z.enum(['created', 'paid', 'declined', 'dropped']),
});

export function registerPaymentRoutes(app: MercatusServer, deps: StoreDeps): void {
  const bankUrl = deps.config.fakeBankUrl;
  if (bankUrl === undefined) {
    // A store with no payment provider configured is a legitimate deployment; a route that
    // pretends to settle without one is not. Say it once, at boot, rather than 500 later.
    app.log.warn('settlement route not registered: FAKE_BANK_URL is not set');
    return;
  }

  app.post(
    '/t/:slug/orders/:id/payment',
    {
      schema: {
        summary: 'Record what the payment provider did with an order',
        description:
          'The body names a payment; the store asks the provider and verifies the payment ' +
          'refers to this order and this amount before believing anything.',
        tags: ['public'],
        params: tenantResourceParamsSchema,
        body: settleOrderPaymentBodySchema,
        response: {
          200: settleOrderPaymentResultSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (req) => {
      let response: Response;
      try {
        response = await fetch(`${bankUrl}/payments/${req.body.paymentId}`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        // Payments are ours and never run on a customer's server (CE2), so an unreachable bank
        // is an outage of OURS. The order stands, unpaid, and the caller may try again.
        throw new ConflictError('The payment provider could not be reached.', {
          logDetail: `${bankUrl} unreachable: ${String(error)}`,
        });
      }
      if (!response.ok) throw new NotFoundError('No such payment.');
      const payment = bankPaymentSchema.parse(await response.json());

      return inTenantTx(deps, req, async (tx, ctx) => {
        const found = await findOrderById(tx, req.params.id);
        // No tenant predicate anywhere: another tenant's order id is simply invisible in this
        // transaction, so this is a 404 and never a cross-tenant read (BE1).
        if (!found) throw new NotFoundError('No such order.');

        // The whole of the authentication. The reference was minted at checkout as
        // `order:<slug>:<number>`, so a payment that does not name THIS order cannot settle it.
        const expected = `order:${ctx.slug}:${String(found.order.number)}`;
        if (payment.reference !== expected) {
          throw new ConflictError('That payment does not belong to this order.', {
            logDetail: `payment reference ${payment.reference} != ${expected}`,
          });
        }
        if (
          payment.amountMinor !== found.order.totalMinor ||
          payment.currency !== found.order.currency
        ) {
          // Agrees about the order, disagrees about the money. One of the two is wrong and
          // believing either would make the check pointless.
          throw new ConflictError('That payment does not match the order total.', {
            logDetail: `payment ${String(payment.amountMinor)} ${payment.currency} != order ${String(found.order.totalMinor)} ${found.order.currency}`,
          });
        }

        if (payment.status !== 'paid' && payment.status !== 'declined') {
          // `created` (still at the bank) or `dropped` (the connection died). Not an outcome;
          // report what the order currently says and let the caller ask again.
          return { orderId: found.order.id, paymentStatus: found.order.paymentStatus };
        }

        const updated = await recordSettlement(tx, {
          orderId: found.order.id,
          paymentStatus: payment.status,
          paymentRef: payment.providerRef,
        });
        if (!updated) throw new NotFoundError('No such order.');
        req.log.info(
          { order: updated.number, payment: payment.providerRef, outcome: payment.status },
          'settlement recorded',
        );
        return { orderId: updated.id, paymentStatus: updated.paymentStatus };
      });
    },
  );
}
