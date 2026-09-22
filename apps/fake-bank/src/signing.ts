/**
 * The shared HMAC. Both directions, one file, so the two canonical forms sit next to each other
 * and cannot quietly disagree.
 *
 * CR1 is why this exists at all: a fake for an external dependency that does NOT check our
 * signature lets a break in our hashing sail past every local test and appear for the first time
 * against a real provider, at which point the only diagnostic is a 4xx from someone else's
 * server. fake-bank verifies our request before it answers anything, and signs its callback so
 * the platform verifies it back. A hashing bug is then a 401 on a laptop.
 *
 * Both canonical strings are the field VALUES joined by `|`, in a fixed order, with no separator
 * escaping -- deliberately the dumbest scheme that works, because the thing being exercised is
 * "do both sides agree", not the scheme. The fields are chosen so nothing an attacker controls
 * can be moved between them without changing the string.
 *
 *   request   reference | amountMinor | currency | callbackUrl
 *   callback  providerRef | status | amountMinor | currency
 *
 * `amountMinor` is written as a base-10 integer (minor units, decisions-made-overnight.md), so
 * there is no float formatting to get wrong.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** What the caller signs when it asks for a payment. */
export interface PaymentRequestParts {
  readonly reference: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly callbackUrl: string;
}

/** What fake-bank signs when it answers. Matches `paymentCallbackBodySchema` in @mercatus/contracts. */
export interface CallbackParts {
  readonly providerRef: string;
  readonly status: string;
  readonly amountMinor: number;
  readonly currency: string;
}

export function paymentRequestCanonical(parts: PaymentRequestParts): string {
  return [parts.reference, String(parts.amountMinor), parts.currency, parts.callbackUrl].join('|');
}

export function callbackCanonical(parts: CallbackParts): string {
  return [parts.providerRef, parts.status, String(parts.amountMinor), parts.currency].join('|');
}

export function sign(secret: string, canonical: string): string {
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}

/**
 * Constant-time, and length-checked first because timingSafeEqual throws on a length mismatch
 * rather than returning false. Both sides are hex of a fixed width, so a differing length is
 * already a rejection.
 */
export function signatureMatches(expected: string, supplied: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(supplied, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
