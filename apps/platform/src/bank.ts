/**
 * The fake-bank client (BUILD-PLAN §6.3, CR1).
 *
 * Our merchant credentials live HERE and are used from here only. A dedicated data plane never
 * calls the bank itself -- it proxies through the control plane -- because a key that bills us
 * must not sit on a customer's server (CE2).
 *
 * The response is parsed leniently on purpose: `id` is the only field we require, and the payment
 * page URL is taken from the bank when it offers one and derived from `id` when it does not. That
 * keeps this file from being the reason the build stops if fake-bank's reply gains or loses a
 * field, which matters while the two are being written at the same time.
 */
import { z } from 'zod';

import { signCreatePayment } from './signature.js';

/**
 * Lenient on purpose. fake-bank answers `{ id, providerRef, reference, amountMinor, currency,
 * status, behaviour, paymentUrl, createdAt }`; the two fields this client cannot do without are
 * the reference it will later see on a callback and the page to send the buyer to. `providerRef`
 * is what the callback carries, so it wins over `id` when both are present.
 */
const bankPaymentSchema = z.object({
  id: z.string().min(1),
  providerRef: z.string().min(1).optional(),
  paymentUrl: z.string().min(1).optional(),
  status: z.string().optional(),
});

export interface CreateBankPayment {
  readonly reference: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly callbackUrl: string;
}

export interface BankPayment {
  /** fake-bank's id. It becomes `payments.provider_ref` -- an attribute, never a key (BV1). */
  readonly providerRef: string;
  readonly paymentUrl: string;
}

export interface BankClient {
  createPayment(input: CreateBankPayment): Promise<BankPayment>;
}

export class BankUnreachableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BankUnreachableError';
  }
}

export function createBankClient(options: {
  baseUrl: string;
  secret: string;
  timeoutMs?: number;
}): BankClient {
  const base = options.baseUrl.replace(/\/+$/, '');

  return {
    createPayment: async (input) => {
      const body = {
        reference: input.reference,
        amountMinor: input.amountMinor,
        currency: input.currency,
        callbackUrl: input.callbackUrl,
        signature: signCreatePayment(options.secret, input),
      };

      let response: Response;
      try {
        response = await fetch(`${base}/payments`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
        });
      } catch (error) {
        // Signup has already committed the tenant as `pending`, so this is recoverable: the buyer
        // retries and the same slug resumes rather than colliding (CK2).
        throw new BankUnreachableError(`fake-bank at ${base} did not answer.`, { cause: error });
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new BankUnreachableError(
          `fake-bank refused the payment: ${String(response.status)} ${text.slice(0, 200)}`,
        );
      }

      const parsed = bankPaymentSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new BankUnreachableError('fake-bank answered a shape this client does not know.');
      }
      return {
        providerRef: parsed.data.providerRef ?? parsed.data.id,
        paymentUrl: parsed.data.paymentUrl ?? `${base}/pay/${parsed.data.id}`,
      };
    },
  };
}
