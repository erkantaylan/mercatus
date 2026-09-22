/**
 * The hosted page and the completion (§6.3).
 *
 * `POST /pay/:id/complete` is the failure-injection surface: it takes the behaviour from the body
 * (the page's buttons), else from `?behaviour=`, else from whatever the payment was opened with,
 * else `approve`. Three ways in and one default, so a curl script, the page and the platform's
 * own integration test all drive the same code.
 */
import { errorEnvelopeSchema, uuidSchema } from '@mercatus/contracts';
import type { MercatusServer } from '@mercatus/core';
import { ConflictError, NotFoundError } from '@mercatus/core';
import { z } from 'zod';

import type { BankPayment } from '../contracts.js';
import {
  bankPaymentSchema,
  completePaymentBodySchema,
  completePaymentQuerySchema,
} from '../contracts.js';
import type { FakeBankDeps } from '../deps.js';
import { renderPaymentPage } from '../page.js';
import { settle } from '../settle.js';
import { toBankPayment } from '../store.js';

const paymentParamsSchema = z.object({ id: uuidSchema });

export function registerPayRoutes(app: MercatusServer, deps: FakeBankDeps): void {
  app.get(
    '/pay/:id',
    {
      schema: {
        summary: 'The hosted payment page',
        description: 'HTML. Five buttons, one per behaviour. Plain, on the shared --mc-* tokens.',
        tags: ['payments'],
        params: paymentParamsSchema,
        // No response schema: the reply is HTML, and a Zod serialiser would turn it into JSON.
        produces: ['text/html'],
      },
    },
    async (req, reply) => {
      const record = deps.payments.get(req.params.id);
      if (!record) throw new NotFoundError('No such payment.');
      return reply.type('text/html; charset=utf-8').send(renderPaymentPage(record));
    },
  );

  app.post(
    '/pay/:id/complete',
    {
      schema: {
        summary: 'Tell the bank what to answer (CR1)',
        description:
          'approve | decline | bad-hash | no-callback | drop. Defaults to the payment\'s own ' +
          'behaviour, which defaults to approve. `drop` destroys the connection, so there is no ' +
          'reply to read -- GET /payments/:id afterwards to see what happened.',
        tags: ['payments'],
        params: paymentParamsSchema,
        querystring: completePaymentQuerySchema,
        body: completePaymentBodySchema,
        response: { 200: bankPaymentSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema },
      },
    },
    async (req, reply) => {
      const record = deps.payments.get(req.params.id);
      if (!record) throw new NotFoundError('No such payment.');

      // A real provider will not settle the same payment twice, and neither does this -- the
      // platform's callback handler is idempotent by providerRef (CK2), so a second settlement
      // would test nothing that a replayed callback does not already test.
      if (record.status !== 'created') {
        throw new ConflictError(`Payment ${record.id} is already ${record.status}.`, {
          details: { status: record.status, behaviour: record.behaviour },
        });
      }

      const behaviour = req.body?.behaviour ?? req.query.behaviour ?? record.behaviour;
      const result = await settle(
        { hmacSecret: deps.config.hmacSecret, log: req.log },
        record,
        behaviour,
      );

      if (result.dropConnection) {
        req.log.warn({ paymentId: record.id }, 'dropping the connection, on purpose');
        // hijack() stops Fastify sending anything; wrap-thenable returns early on a hijacked
        // reply, so the `undefined` below is never serialised. The cast is the price of a route
        // that has one path with a body and one path with no response at all.
        reply.hijack();
        req.socket.destroy();
        return undefined as unknown as BankPayment;
      }

      return toBankPayment(result.record);
    },
  );
}
