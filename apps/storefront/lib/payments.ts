/**
 * Paying for an order through fake-bank (CR1).
 *
 * The shape of the flow, and why it is this shape:
 *
 *   1. the store API places the order        -- prices come from the products table, never the post
 *   2. this app asks fake-bank for a payment -- signed, so a hashing bug is a 401 on a laptop
 *   3. the browser is redirected to the bank -- the shopper really leaves and really comes back
 *   4. the bank posts a signed callback here -- verified before it is believed
 *
 * The signing scheme is fake-bank's, restated rather than imported: `apps/fake-bank/src/signing.ts`
 * is inside an application, not a package, and fake-bank is run-mode only so nothing may depend on
 * it. `reference | amountMinor | currency | callbackUrl` for the request, joined by `|`.
 *
 * `STOREFRONT KNOWS THE SECRET` is a POC compromise and a CE2 violation on a dedicated instance,
 * where this process runs on the merchant's own server. The correct path is the store API calling
 * the control plane's `POST /payments/proxy`, which exists; wiring it needs a route on the store
 * API that task 07a may not touch. Recorded in decisions-made-overnight.md.
 *
 * The settlement ledger is a Map on globalThis. It is per-process and it is lost on restart, and
 * that is the right size for it: the authority on whether a payment settled is fake-bank, which
 * this module asks whenever the ledger has nothing (`paymentState`). The ledger exists so the
 * VERIFIED callback is what normally answers, rather than a poll that would believe anything.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { config } from '@/lib/config';

export const paymentOutcomeSchema = z.enum(['pending', 'paid', 'declined']);
export type PaymentOutcome = z.infer<typeof paymentOutcomeSchema>;

export interface PaymentRecord {
  readonly orderId: string;
  readonly slug: string;
  readonly paymentId: string;
  readonly providerRef: string;
  readonly amountMinor: number;
  readonly currency: string;
  outcome: PaymentOutcome;
  /** How the outcome was learnt. `callback` means the signature verified. */
  source: 'pending' | 'callback' | 'bank';
}

interface Ledger {
  readonly byOrder: Map<string, PaymentRecord>;
  readonly byProviderRef: Map<string, PaymentRecord>;
}

const LEDGER_KEY = Symbol.for('mercatus.storefront.payments');

function ledger(): Ledger {
  const host = globalThis as unknown as Record<symbol, Ledger | undefined>;
  // Survives the dev server's hot reloads, which replace the module but not the global.
  host[LEDGER_KEY] ??= { byOrder: new Map(), byProviderRef: new Map() };
  const found = host[LEDGER_KEY];
  if (!found) throw new Error('unreachable: the ledger was just assigned');
  return found;
}

function sign(secret: string, canonical: string): string {
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}

function signatureMatches(expected: string, supplied: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(supplied, 'utf8');
  // timingSafeEqual throws on a length mismatch rather than returning false, and both sides are
  // hex of a fixed width, so a differing length is already a rejection.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const createPaymentResultSchema = z.object({
  id: z.uuid(),
  providerRef: z.string(),
  paymentUrl: z.url(),
});

const bankPaymentSchema = z.object({
  id: z.uuid(),
  providerRef: z.string(),
  status: z.enum(['created', 'paid', 'declined', 'dropped']),
});

/**
 * Creates the payment and returns the hosted page to send the browser to. The reference names the
 * order it pays for, which is what makes a bank record readable next to a store order.
 */
export async function createPayment(input: {
  slug: string;
  orderId: string;
  orderNumber: number;
  amountMinor: number;
  currency: string;
}): Promise<{ paymentUrl: string }> {
  const { fakeBankUrl, fakeBankHmacSecret, publicUrl } = config();
  const callbackUrl = `${publicUrl}/api/payments/callback`;
  const reference = `order:${input.slug}:${String(input.orderNumber)}`;
  const signature = sign(
    fakeBankHmacSecret,
    [reference, String(input.amountMinor), input.currency, callbackUrl].join('|'),
  );

  const response = await fetch(`${fakeBankUrl}/payments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      amountMinor: input.amountMinor,
      currency: input.currency,
      reference,
      callbackUrl,
      signature,
    }),
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`fake-bank refused the payment: ${String(response.status)}`);
  }

  const created = createPaymentResultSchema.parse(await response.json());
  const record: PaymentRecord = {
    orderId: input.orderId,
    slug: input.slug,
    paymentId: created.id,
    providerRef: created.providerRef,
    amountMinor: input.amountMinor,
    currency: input.currency,
    outcome: 'pending',
    source: 'pending',
  };
  const { byOrder, byProviderRef } = ledger();
  byOrder.set(record.orderId, record);
  byProviderRef.set(record.providerRef, record);

  return { paymentUrl: created.paymentUrl };
}

/**
 * The bank's callback. Verified before it is believed -- an unsigned or wrongly-signed callback
 * is refused, which is the `bad-hash` behaviour doing its job.
 */
export function recordCallback(body: {
  providerRef: string;
  status: 'created' | 'paid' | 'declined';
  amountMinor: number;
  currency: string;
  signature: string;
}): { accepted: boolean; reason?: string } {
  const { fakeBankHmacSecret } = config();
  const expected = sign(
    fakeBankHmacSecret,
    [body.providerRef, body.status, String(body.amountMinor), body.currency].join('|'),
  );
  if (!signatureMatches(expected, body.signature)) {
    return { accepted: false, reason: 'signature did not verify' };
  }

  const record = ledger().byProviderRef.get(body.providerRef);
  if (!record) return { accepted: false, reason: 'no such payment' };

  if (record.amountMinor !== body.amountMinor || record.currency !== body.currency) {
    // A callback that agrees with its own signature but not with the payment it names is a bug in
    // one of the two, and accepting it would make the signature pointless.
    return { accepted: false, reason: 'amount does not match the payment' };
  }

  if (body.status === 'created') return { accepted: false, reason: 'a callback reports a settlement' };

  record.outcome = body.status;
  record.source = 'callback';
  return { accepted: true };
}

/**
 * What the confirmation page shows. The ledger answers first; when it has nothing settled yet the
 * bank is asked, so a shopper who comes back faster than the callback does not see "pending"
 * forever. The bank's answer is never treated as verified -- `source` says which it was.
 */
export async function paymentState(
  orderId: string,
): Promise<{ outcome: PaymentOutcome; source: PaymentRecord['source'] } | null> {
  const record = ledger().byOrder.get(orderId);
  if (!record) return null;
  if (record.outcome !== 'pending') return { outcome: record.outcome, source: record.source };

  const { fakeBankUrl } = config();
  try {
    const response = await fetch(`${fakeBankUrl}/payments/${record.paymentId}`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) return { outcome: 'pending', source: record.source };
    const bank = bankPaymentSchema.parse(await response.json());
    if (bank.status === 'paid' || bank.status === 'declined') {
      record.outcome = bank.status;
      record.source = 'bank';
    }
  } catch {
    // The bank being unreachable is not an outcome. Stay pending and let the page say so.
  }
  return { outcome: record.outcome, source: record.source };
}
