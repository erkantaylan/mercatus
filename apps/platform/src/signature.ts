/**
 * The HMAC that binds us to fake-bank, in both directions (CR1).
 *
 * fake-bank verifies OUR signature before it answers, and we verify ITS signature before a
 * payment settles anything. That is the whole reason a fake is better than a sandbox: a break in
 * our signing shows up on a laptop, in a test, rather than at a real acquirer six weeks later.
 *
 * THE CANONICAL STRING IS THE CONTRACT. It is a `|`-joined field list, in a fixed order, with no
 * JSON and no key sorting -- canonical JSON is a subtle thing to get two implementations to agree
 * on, and there is nothing here that needs it:
 *
 *   create payment   reference | amountMinor | currency | callbackUrl
 *   callback         providerRef | status | amountMinor | currency
 *
 * Signature is lowercase hex of HMAC-SHA256 under FAKE_BANK_HMAC_SECRET, which lives in the
 * control plane and never on a customer's server (CE2). Recorded in decisions-made-overnight.md
 * so apps/fake-bank and this file cannot drift.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface CreatePaymentSignatureInput {
  readonly reference: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly callbackUrl: string;
}

export interface CallbackSignatureInput {
  readonly providerRef: string;
  readonly status: string;
  readonly amountMinor: number;
  readonly currency: string;
}

function hmacHex(secret: string, canonical: string): string {
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}

export function createPaymentCanonical(input: CreatePaymentSignatureInput): string {
  return [input.reference, String(input.amountMinor), input.currency, input.callbackUrl].join('|');
}

export function callbackCanonical(input: CallbackSignatureInput): string {
  return [input.providerRef, input.status, String(input.amountMinor), input.currency].join('|');
}

export function signCreatePayment(secret: string, input: CreatePaymentSignatureInput): string {
  return hmacHex(secret, createPaymentCanonical(input));
}

export function signCallback(secret: string, input: CallbackSignatureInput): string {
  return hmacHex(secret, callbackCanonical(input));
}

/**
 * Constant time, and length-checked first because timingSafeEqual throws on a length mismatch --
 * which would turn a forged signature of the wrong length into a 500 instead of a refusal.
 */
export function signatureMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifyCallbackSignature(
  secret: string,
  input: CallbackSignatureInput & { signature: string },
): boolean {
  return signatureMatches(signCallback(secret, input), input.signature);
}
