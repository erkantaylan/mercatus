/**
 * The five answers (CR1). This is the only file that decides what a payment does, so the table
 * below is the whole feature and there is nowhere else for a sixth behaviour to hide.
 *
 * | behaviour     | bank's books | callback        | our connection |
 * |---------------|--------------|-----------------|----------------|
 * | approve       | paid         | signed, `paid`  | answered       |
 * | decline       | declined     | signed, `declined` | answered    |
 * | bad-hash      | paid         | CORRUPT signature | answered     |
 * | no-callback   | paid         | none            | answered       |
 * | drop          | dropped      | none            | destroyed      |
 *
 * `no-callback` is the interesting one: the bank took the money and we were never told, so our
 * books and theirs disagree. That is the state a reconciliation job exists for, and it is worth
 * being able to produce on demand on a laptop.
 *
 * The callback is AWAITED before the completion is answered. A real provider would fire it
 * asynchronously, but a fake whose whole job is to be driven from a shell script has to be
 * deterministic: after `curl .../complete` returns, the callback has already been delivered or
 * already failed, and `GET /payments/:id` says which.
 */
import { paymentCallbackBodySchema } from '@mercatus/contracts';
import type { FastifyBaseLogger } from 'fastify';

import type { Behaviour, CallbackAttempt } from './contracts.js';
import { callbackCanonical, sign } from './signing.js';
import type { PaymentRecord } from './store.js';

/** How long fake-bank waits for our callback endpoint before calling it a transport failure. */
const CALLBACK_TIMEOUT_MS = 5_000;

interface Plan {
  readonly status: PaymentRecord['status'];
  /** What the callback reports. null means no callback is sent at all. */
  readonly callbackStatus: 'paid' | 'declined' | null;
  readonly corruptSignature: boolean;
  /** Destroy the socket instead of answering the completion. */
  readonly dropConnection: boolean;
}

const PLANS: Record<Behaviour, Plan> = {
  approve: { status: 'paid', callbackStatus: 'paid', corruptSignature: false, dropConnection: false },
  decline: {
    status: 'declined',
    callbackStatus: 'declined',
    corruptSignature: false,
    dropConnection: false,
  },
  'bad-hash': { status: 'paid', callbackStatus: 'paid', corruptSignature: true, dropConnection: false },
  'no-callback': { status: 'paid', callbackStatus: null, corruptSignature: false, dropConnection: false },
  drop: { status: 'dropped', callbackStatus: null, corruptSignature: false, dropConnection: true },
};

export interface SettleResult {
  readonly record: PaymentRecord;
  /** The route destroys the connection instead of replying when this is true. */
  readonly dropConnection: boolean;
}

export interface SettleDeps {
  readonly hmacSecret: string;
  readonly log: FastifyBaseLogger;
}

export async function settle(
  deps: SettleDeps,
  record: PaymentRecord,
  behaviour: Behaviour,
): Promise<SettleResult> {
  const plan = PLANS[behaviour];

  record.behaviour = behaviour;
  record.status = plan.status;
  record.settledAt = new Date().toISOString();

  if (plan.callbackStatus === null) {
    record.callback = {
      attempted: false,
      delivered: false,
      httpStatus: null,
      error: null,
      reportedStatus: null,
      signature: null,
      signatureCorrupted: false,
      at: record.settledAt,
    };
    deps.log.info(
      { paymentId: record.id, behaviour, status: record.status },
      'settled without a callback, on purpose',
    );
    return { record, dropConnection: plan.dropConnection };
  }

  const canonical = callbackCanonical({
    providerRef: record.providerRef,
    status: plan.callbackStatus,
    amountMinor: record.amountMinor,
    currency: record.currency,
  });

  // A corrupted signature is still a well-formed hex string of the right length -- it is signed
  // with the wrong secret. Truncating it instead would be caught by a length check rather than by
  // the comparison, which is not the failure we want to rehearse.
  const signature = plan.corruptSignature
    ? sign(`${deps.hmacSecret}-deliberately-wrong`, canonical)
    : sign(deps.hmacSecret, canonical);

  // Parsed against the contract before it is sent: if the two sides of the callback ever drift,
  // it fails HERE, in the fake, rather than as an unexplained 400 in the platform's log.
  const body = paymentCallbackBodySchema.parse({
    providerRef: record.providerRef,
    status: plan.callbackStatus,
    amountMinor: record.amountMinor,
    currency: record.currency,
    signature,
  });

  const attempt = await deliver(record.callbackUrl, body);
  record.callback = {
    ...attempt,
    reportedStatus: plan.callbackStatus,
    signature,
    signatureCorrupted: plan.corruptSignature,
    at: new Date().toISOString(),
  };

  deps.log.info(
    {
      paymentId: record.id,
      behaviour,
      status: record.status,
      callbackStatus: attempt.httpStatus,
      delivered: attempt.delivered,
      signatureCorrupted: plan.corruptSignature,
    },
    'settled and called back',
  );

  return { record, dropConnection: plan.dropConnection };
}

type DeliveryOutcome = Pick<CallbackAttempt, 'attempted' | 'delivered' | 'httpStatus' | 'error'>;

async function deliver(url: string, body: unknown): Promise<DeliveryOutcome> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    });
    // `delivered` is 2xx only. A 401 from our verifier is a callback that ARRIVED and was
    // refused, which is exactly what `bad-hash` is meant to produce -- and the distinction is the
    // reason this is two booleans rather than one.
    return { attempted: true, delivered: res.ok, httpStatus: res.status, error: null };
  } catch (error) {
    return {
      attempted: true,
      delivered: false,
      httpStatus: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
