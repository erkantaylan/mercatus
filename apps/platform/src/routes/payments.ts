/**
 * `POST /payments/callback` -- fake-bank tells us what happened (architecture.md §6).
 *
 * Three properties, in the order they are checked:
 *
 *   SIGNED     the HMAC is verified before anything is read, let alone written (CR1). A callback
 *              that does not verify is one generic 401 and a log line saying which check failed
 *              (S1) -- never "unknown payment", which would say whether the reference exists.
 *   IDEMPOTENT keyed on `provider_ref`, which is unique. A bank that retries, or delivers twice,
 *              settles the same row once and answers 204 both times (CK2).
 *   ALL OR NOTHING  settling the payment, activating the tenant and issuing the licence are one
 *              transaction. A half-made tenant is the failure CK2 is named after.
 *
 * The amount is checked against what we asked for. A callback that agrees with its own signature
 * but not with our payment row is a bug in one of the two, and silently accepting it would make
 * the signature pointless.
 */
import { errorEnvelopeSchema, paymentCallbackBodySchema } from '@mercatus/contracts';
import type { MercatusServer } from '@mercatus/core';
import { ConflictError, NotFoundError, UnauthenticatedError, ValidationError } from '@mercatus/core';
import { findPaymentByProviderRef, findTenantById, issueLicence, settlePayment, setTenantStatus } from '@mercatus/db-platform';
import { z } from 'zod';

import type { PlatformDeps } from '../deps.js';
import { defaultValidUntil } from '../licence.js';
import { verifyCallbackSignature } from '../signature.js';

export function registerPaymentRoutes(app: MercatusServer, deps: PlatformDeps): void {
  app.post(
    '/payments/callback',
    {
      schema: {
        summary: "fake-bank's signed callback. Verifies, settles, activates, issues the licence",
        tags: ['buy-a-store'],
        body: paymentCallbackBodySchema,
        response: {
          // 204 carries no body; Fastify sends none, and the schema says as much.
          204: z.null(),
          401: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
        },
      },
    },
    async (req, reply) => {
      const body = req.body;

      if (!verifyCallbackSignature(deps.config.fakeBankHmacSecret, body)) {
        throw new UnauthenticatedError(undefined, {
          logDetail: `callback signature did not verify for providerRef ${body.providerRef}`,
        });
      }

      if (body.status === 'created') {
        throw new ValidationError('A callback reports a settlement, not a creation.');
      }

      const payment = await findPaymentByProviderRef(deps.db, body.providerRef);
      if (!payment) throw new NotFoundError('No such payment.');

      if (payment.status !== 'created') {
        // Already settled. Same answer as the first time -- that is what idempotent means.
        req.log.info({ providerRef: body.providerRef }, 'callback replayed; nothing to do');
        await reply.status(204).send(null);
        return;
      }

      if (payment.amountMinor !== body.amountMinor || payment.currency !== body.currency) {
        throw new ConflictError('The callback does not match the payment it names.', {
          logDetail: `expected ${String(payment.amountMinor)} ${payment.currency}, got ${String(body.amountMinor)} ${body.currency}`,
        });
      }

      if (body.status === 'declined') {
        await settlePayment(deps.db, { id: payment.id, status: 'declined' });
        // The tenant stays pending, with its slug and its id. Retrying is a new payment, not a
        // new store: everything the buyer typed survives the card being refused.
        req.log.info({ providerRef: body.providerRef }, 'payment declined; tenant stays pending');
        await reply.status(204).send(null);
        return;
      }

      await deps.db.transaction(async (tx) => {
        await settlePayment(tx, { id: payment.id, status: 'paid' });
        await setTenantStatus(tx, payment.tenantId, 'active');
        await issueLicence(tx, { tenantId: payment.tenantId, validUntil: defaultValidUntil() });
      });

      const tenant = await findTenantById(deps.db, payment.tenantId);
      req.log.info(
        { providerRef: body.providerRef, tenant: tenant?.slug, tenantId: payment.tenantId },
        'payment settled: tenant active, licence issued',
      );
      await reply.status(204).send(null);
      return;
    },
  );
}
