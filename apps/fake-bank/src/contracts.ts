/**
 * fake-bank's own wire shapes.
 *
 * They are local rather than in @mercatus/contracts for one reason: fake-bank is run-mode only
 * and never published (§6.3, CR1), while @mercatus/contracts is imported by every app including
 * the ones that do ship. The one shape that crosses the boundary -- the callback body -- is
 * imported FROM @mercatus/contracts (`paymentCallbackBodySchema`) rather than restated here, so
 * the two sides of the only contract that matters cannot drift.
 *
 * A response is serialised through its Zod schema, so anything a handler returns that is not
 * named here is silently dropped. Extend the schema, not just the handler.
 */
import { currencySchema, minorAmountSchema, uuidSchema } from '@mercatus/contracts';
import { z } from 'zod';

/**
 * The five answers a developer can ask for (CR1). `approve` is the default everywhere, so the
 * happy path needs no ceremony and every failure is opt-in.
 *
 *   approve      money taken, callback sent, status `paid`
 *   decline      money refused, callback sent, status `declined`
 *   bad-hash     money taken, callback sent with a CORRUPTED signature -- our verifier must refuse it
 *   no-callback  money taken, and we are never told. The bank's books and ours disagree
 *   drop         the connection is destroyed mid-answer; no reply, no callback
 */
export const behaviourSchema = z.enum(['approve', 'decline', 'bad-hash', 'no-callback', 'drop']);

/**
 * fake-bank's internal state. `created | paid | declined` are the three the platform knows
 * (`paymentStatusSchema` in @mercatus/contracts); `dropped` is fake-bank's alone, because a
 * dropped connection is not an outcome a real provider would ever report to us -- we would only
 * ever see the socket close.
 */
export const bankPaymentStatusSchema = z.enum(['created', 'paid', 'declined', 'dropped']);

/**
 * What the platform sends. `signature` is verified BEFORE anything is created (CR1); everything
 * else is taken on trust, because this is a fake and the amount is not real.
 */
export const createPaymentBodySchema = z.object({
  amountMinor: minorAmountSchema,
  currency: currencySchema,
  /** Our reference. fake-bank echoes it back and never interprets it. */
  reference: z.string().min(1).max(200),
  /** Where the signed callback goes. Absolute, because a bank is not on our host. */
  callbackUrl: z.url(),
  signature: z.string().min(1),
});

/** How the caller steers a payment without opening the page: `POST /payments?behaviour=decline`. */
export const createPaymentQuerySchema = z.object({
  behaviour: behaviourSchema.default('approve'),
});

export const createPaymentResultSchema = z.object({
  id: uuidSchema,
  /** `fb_<id>`. The platform stores this as `payments.provider_ref` and keys idempotency on it. */
  providerRef: z.string(),
  reference: z.string(),
  amountMinor: minorAmountSchema,
  currency: currencySchema,
  status: bankPaymentStatusSchema,
  /** What this payment will do when completed unless the completion overrides it. */
  behaviour: behaviourSchema,
  /** The hosted page. This is what `/signup` hands back to the browser as `paymentUrl`. */
  paymentUrl: z.url(),
  createdAt: z.iso.datetime({ offset: true }),
});

/**
 * Body of `POST /pay/:id/complete`. Empty means "use the payment's own behaviour".
 *
 * `.nullish()`, not `.optional()`: Fastify hands a body-less POST to the validator as **null**,
 * so an optional-only schema answers 400 to `curl -X POST` with no `-d`, which is the most
 * obvious way anyone will ever drive this endpoint.
 */
export const completePaymentBodySchema = z
  .object({ behaviour: behaviourSchema.optional() })
  .strict()
  .nullish();

export const completePaymentQuerySchema = z.object({
  behaviour: behaviourSchema.optional(),
});

/** What happened when fake-bank tried to call us back. Null until a completion is attempted. */
export const callbackAttemptSchema = z
  .object({
    /** false for `no-callback` and `drop` -- the two behaviours whose whole point is silence. */
    attempted: z.boolean(),
    /** true only for a 2xx. A 4xx from our verifier is a delivered callback that we REFUSED. */
    delivered: z.boolean(),
    httpStatus: z.number().int().nullable(),
    /** The transport error, if the callback never got a status at all. */
    error: z.string().nullable(),
    /** The status fake-bank reported. Not necessarily the status we recorded. */
    reportedStatus: z.string().nullable(),
    signature: z.string().nullable(),
    /** True when the signature was deliberately corrupted (`bad-hash`). */
    signatureCorrupted: z.boolean(),
    at: z.iso.datetime({ offset: true }).nullable(),
  })
  .nullable();

export const bankPaymentSchema = z.object({
  id: uuidSchema,
  providerRef: z.string(),
  reference: z.string(),
  amountMinor: minorAmountSchema,
  currency: currencySchema,
  status: bankPaymentStatusSchema,
  behaviour: behaviourSchema,
  callbackUrl: z.url(),
  createdAt: z.iso.datetime({ offset: true }),
  settledAt: z.iso.datetime({ offset: true }).nullable(),
  callback: callbackAttemptSchema,
});

export type Behaviour = z.infer<typeof behaviourSchema>;
export type BankPaymentStatus = z.infer<typeof bankPaymentStatusSchema>;
export type CreatePaymentBody = z.infer<typeof createPaymentBodySchema>;
export type CreatePaymentResult = z.infer<typeof createPaymentResultSchema>;
export type CallbackAttempt = NonNullable<z.infer<typeof callbackAttemptSchema>>;
export type BankPayment = z.infer<typeof bankPaymentSchema>;
