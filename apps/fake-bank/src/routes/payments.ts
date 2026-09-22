/**
 * `POST /payments` and `GET /payments/:id` (§6.3).
 *
 * The signature check on the way in is the reason fake-bank is worth building at all (CR1): a
 * fake that answers anything it is sent lets our own hashing rot silently until it meets a real
 * provider. Here a mismatch is a 401 on a laptop, with the canonical string fake-bank hashed in
 * the body -- which is the one piece of information that turns "signature invalid" into a fix,
 * and which contains no secret.
 *
 * S1 says put the real reason in `logDetail` and give the wire a generic code. That rule is about
 * auth-shaped endpoints an attacker can probe for accounts. This endpoint has no accounts to
 * enumerate and never ships (§6.3), so the diagnostic goes in `details` deliberately; see
 * decisions-made-overnight.md.
 */
import { errorEnvelopeSchema } from '@mercatus/contracts';
import type { MercatusServer } from '@mercatus/core';
import { NotFoundError, UnauthenticatedError } from '@mercatus/core';

import {
  bankPaymentSchema,
  createPaymentBodySchema,
  createPaymentQuerySchema,
  createPaymentResultSchema,
} from '../contracts.js';
import type { FakeBankDeps } from '../deps.js';
import { paymentRequestCanonical, sign, signatureMatches } from '../signing.js';
import { toBankPayment } from '../store.js';

export function registerPaymentRoutes(app: MercatusServer, deps: FakeBankDeps): void {
  app.post(
    '/payments',
    {
      schema: {
        summary: 'Open a payment. Verifies OUR signature before answering (CR1)',
        description:
          'signature = HMAC-SHA256(FAKE_BANK_HMAC_SECRET, "reference|amountMinor|currency|callbackUrl"), hex. ' +
          'The optional ?behaviour= query fixes what this payment will do when completed, so a ' +
          'caller can drive a failure without opening the page. Default: approve.',
        tags: ['payments'],
        body: createPaymentBodySchema,
        querystring: createPaymentQuerySchema,
        response: { 200: createPaymentResultSchema, 401: errorEnvelopeSchema },
      },
    },
    async (req) => {
      const body = req.body;
      const canonical = paymentRequestCanonical(body);
      const expected = sign(deps.config.hmacSecret, canonical);

      if (!signatureMatches(expected, body.signature)) {
        throw new UnauthenticatedError('The request signature does not match.', {
          // Not the secret, and not the expected digest -- the string fake-bank hashed. That is
          // what tells you whether the caller assembled the canonical form differently.
          details: { canonical, algorithm: 'HMAC-SHA256(secret, canonical) as lowercase hex' },
          logDetail: `signature mismatch for reference=${body.reference}; canonical=${canonical}`,
        });
      }

      const record = deps.payments.create({
        reference: body.reference,
        amountMinor: body.amountMinor,
        currency: body.currency,
        callbackUrl: body.callbackUrl,
        behaviour: req.query.behaviour,
      });

      // Built from the request rather than from a configured base URL: fake-bank sits behind
      // Aspire and (later) Traefik, `trustProxy` is on in createServer, and this keeps
      // FAKE_BANK_URL a thing only the platform needs to know (§8.2).
      const paymentUrl = `${req.protocol}://${req.host}/pay/${record.id}`;

      req.log.info(
        { paymentId: record.id, reference: record.reference, behaviour: record.behaviour },
        'payment opened',
      );

      return {
        id: record.id,
        providerRef: record.providerRef,
        reference: record.reference,
        amountMinor: record.amountMinor,
        currency: record.currency,
        status: record.status,
        behaviour: record.behaviour,
        paymentUrl,
        createdAt: record.createdAt,
      };
    },
  );

  app.get(
    '/payments/:id',
    {
      schema: {
        summary: 'The payment as the bank sees it, including what the callback did',
        tags: ['payments'],
        params: bankPaymentSchema.pick({ id: true }),
        response: { 200: bankPaymentSchema, 404: errorEnvelopeSchema },
      },
    },
    async (req) => {
      const record = deps.payments.get(req.params.id);
      if (!record) throw new NotFoundError('No such payment.');
      return toBankPayment(record);
    },
  );
}
