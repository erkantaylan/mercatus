/**
 * The whole database (§6.3: "In-memory store. No database.").
 *
 * A Map that dies with the process is the right amount of durability for a thing whose purpose is
 * to be told what to answer. Nothing here outlives a demo, and a payment that survived a restart
 * would only make the failure-injection harder to reason about.
 */
import { randomUUID } from 'node:crypto';

import type { Behaviour, BankPayment, BankPaymentStatus, CallbackAttempt } from './contracts.js';

export interface PaymentRecord {
  readonly id: string;
  readonly providerRef: string;
  readonly reference: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly callbackUrl: string;
  readonly createdAt: string;
  status: BankPaymentStatus;
  behaviour: Behaviour;
  settledAt: string | null;
  callback: CallbackAttempt | null;
}

export interface PaymentStore {
  create(input: {
    reference: string;
    amountMinor: number;
    currency: string;
    callbackUrl: string;
    behaviour: Behaviour;
  }): PaymentRecord;
  get(id: string): PaymentRecord | null;
  all(): readonly PaymentRecord[];
}

export function createPaymentStore(): PaymentStore {
  const payments = new Map<string, PaymentRecord>();

  return {
    create(input) {
      const id = randomUUID();
      const record: PaymentRecord = {
        id,
        // Prefixed so a provider reference is never mistaken for one of our own uuids (BV1: it is
        // an attribute on the platform's payment row, never a key).
        providerRef: `fb_${id}`,
        reference: input.reference,
        amountMinor: input.amountMinor,
        currency: input.currency,
        callbackUrl: input.callbackUrl,
        createdAt: new Date().toISOString(),
        status: 'created',
        behaviour: input.behaviour,
        settledAt: null,
        callback: null,
      };
      payments.set(id, record);
      return record;
    },
    get(id) {
      return payments.get(id) ?? null;
    },
    all() {
      return [...payments.values()];
    },
  };
}

/** The record as it goes on the wire. Everything here is in `bankPaymentSchema`. */
export function toBankPayment(record: PaymentRecord): BankPayment {
  return {
    id: record.id,
    providerRef: record.providerRef,
    reference: record.reference,
    amountMinor: record.amountMinor,
    currency: record.currency,
    status: record.status,
    behaviour: record.behaviour,
    callbackUrl: record.callbackUrl,
    createdAt: record.createdAt,
    settledAt: record.settledAt,
    callback: record.callback,
  };
}
