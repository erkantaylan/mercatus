/**
 * `POST /t/:slug/orders/:id/payment` -- the settlement the merchant actually sees.
 *
 * The defect behind this file: a paid order and an abandoned one were indistinguishable in the
 * dashboard. The bank settled, the storefront verified the callback, and the fact lived in a Map
 * in that Node process -- lost on restart, absent from every database, never shown to the
 * merchant.
 *
 * What it holds down:
 *   - a settled payment marks the order paid, and the staff API says so
 *   - a payment that names ANOTHER order is refused (409), which is the whole authentication
 *   - a payment whose amount disagrees with the order is refused (409)
 *   - another tenant's order id is a 404, not a cross-tenant write (BE1)
 *   - a declined payment is recorded as declined and does NOT cancel the order
 *
 * The bank is a real HTTP server on an ephemeral port, not a mock: the route's job is to go and
 * ask somebody else, and a stubbed fetch would test the half that was never in doubt.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import type { StoreConfig } from '@mercatus/core';
import { loadStoreConfig } from '@mercatus/core';
import type { StoreDbHandle } from '@mercatus/db-store';
import {
  createStoreDb,
  ensureOrderCounter,
  insertProduct,
  mirrorTenant,
  withExplicitTenantTx,
} from '@mercatus/db-store';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { StoreApp } from '../src/app.js';
import { buildStoreApp } from '../src/app.js';

interface BankPayment {
  id: string;
  providerRef: string;
  reference: string;
  amountMinor: number;
  currency: string;
  status: 'created' | 'paid' | 'declined' | 'dropped';
}

const A = { id: randomUUID(), slug: `set-a-${randomUUID().slice(0, 8)}` };
const B = { id: randomUUID(), slug: `set-b-${randomUUID().slice(0, 8)}` };

const payments = new Map<string, BankPayment>();

let bank: Server;
let bankUrl = '';
let store: StoreApp | undefined;
let admin: StoreDbHandle | undefined;
let shopperToken = '';
let staffTokenA = '';
let productA = '';
let productB = '';

function config(): StoreConfig {
  return loadStoreConfig({
    DATABASE_URL: inject('storeDb').appUrl,
    AUTH_STUB_SECRET: 'test-stub-secret-that-is-long-enough',
    DEPLOYMENT_MODE: 'pooled',
    FAKE_BANK_URL: bankUrl,
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
  });
}

/** Mints a payment the way fake-bank would, and hands back its id. */
function bankPayment(over: Partial<BankPayment>): string {
  const id = randomUUID();
  const payment: BankPayment = {
    id,
    providerRef: `fb_${id}`,
    reference: 'order:nobody:1',
    amountMinor: 0,
    currency: 'TRY',
    status: 'paid',
    ...over,
  };
  payments.set(id, payment);
  return id;
}

async function checkout(slug: string, productId: string): Promise<{ orderId: string; number: number }> {
  const res = await store!.app.inject({
    method: 'POST',
    url: `/t/${slug}/checkout`,
    headers: { authorization: `Bearer ${shopperToken}` },
    payload: { lines: [{ productId, qty: 1 }], shopper: { phone: '+905550007777' } },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { orderId: string; number: number };
}

function settle(slug: string, orderId: string, paymentId: string) {
  return store!.app.inject({
    method: 'POST',
    url: `/t/${slug}/orders/${orderId}/payment`,
    payload: { paymentId },
  });
}

async function orderFromStaffApi(token: string, orderId: string) {
  const res = await store!.app.inject({
    method: 'GET',
    url: `/api/orders/${orderId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { status: string; paymentStatus: string; paymentRef: string | null };
}

beforeAll(async () => {
  bank = createServer((req, res) => {
    const id = (req.url ?? '').replace('/payments/', '');
    const payment = payments.get(id);
    res.setHeader('content-type', 'application/json');
    if (!payment) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no' } }));
      return;
    }
    res.end(JSON.stringify(payment));
  });
  await new Promise<void>((resolve) => bank.listen(0, '127.0.0.1', resolve));
  bankUrl = `http://127.0.0.1:${String((bank.address() as AddressInfo).port)}`;

  admin = createStoreDb(inject('storeDb').adminUrl, { max: 2 });
  for (const tenant of [A, B]) {
    await withExplicitTenantTx(admin.db, tenant.id, async (tx) => {
      await mirrorTenant(tx, { id: tenant.id, slug: tenant.slug, name: tenant.slug });
      await ensureOrderCounter(tx, tenant.id);
      const product = await insertProduct(tx, tenant.id, {
        sku: 'SET-1',
        title: 'A thing to pay for',
        priceMinor: 2500,
        stock: 20,
      });
      if (tenant === A) productA = product.id;
      else productB = product.id;
    });
  }

  store = await buildStoreApp(config());
  await store.app.ready();

  const shopper = await store.app.inject({
    method: 'POST',
    url: '/dev/login/shopper',
    payload: { phone: '+905550007777' },
  });
  shopperToken = (shopper.json() as { accessToken: string }).accessToken;

  const staff = await store.app.inject({
    method: 'POST',
    url: '/dev/login/staff',
    payload: { slug: A.slug, role: 'owner' },
  });
  staffTokenA = (staff.json() as { accessToken: string }).accessToken;
}, 60_000);

afterAll(async () => {
  await store?.close();
  await admin?.close();
  await new Promise<void>((resolve) => bank.close(() => {
    resolve();
  }));
});

describe('recording what the bank did', () => {
  it('an order starts unpaid, and the merchant can see that it is', async () => {
    const placed = await checkout(A.slug, productA);
    const order = await orderFromStaffApi(staffTokenA, placed.orderId);
    expect(order.status).toBe('placed');
    expect(order.paymentStatus).toBe('unpaid');
  });

  it('a settled payment marks the order paid, in the database the merchant reads', async () => {
    const placed = await checkout(A.slug, productA);
    const paymentId = bankPayment({
      reference: `order:${A.slug}:${String(placed.number)}`,
      amountMinor: 2500,
      status: 'paid',
    });

    const res = await settle(A.slug, placed.orderId, paymentId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ orderId: placed.orderId, paymentStatus: 'paid' });

    const order = await orderFromStaffApi(staffTokenA, placed.orderId);
    expect(order.paymentStatus).toBe('paid');
    // The order's own status follows, so every existing screen shows it with no new column.
    expect(order.status).toBe('paid');
    expect(order.paymentRef).toBe(`fb_${paymentId}`);
  });

  it('is idempotent -- the same settlement twice says the same thing', async () => {
    const placed = await checkout(A.slug, productA);
    const paymentId = bankPayment({
      reference: `order:${A.slug}:${String(placed.number)}`,
      amountMinor: 2500,
    });
    expect((await settle(A.slug, placed.orderId, paymentId)).statusCode).toBe(200);
    const second = await settle(A.slug, placed.orderId, paymentId);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ paymentStatus: 'paid' });
  });

  it('refuses a payment that names a DIFFERENT order -- the whole authentication', async () => {
    const one = await checkout(A.slug, productA);
    const two = await checkout(A.slug, productA);
    const paymentId = bankPayment({
      reference: `order:${A.slug}:${String(one.number)}`,
      amountMinor: 2500,
    });

    const res = await settle(A.slug, two.orderId, paymentId);
    expect(res.statusCode).toBe(409);
    expect((await orderFromStaffApi(staffTokenA, two.orderId)).paymentStatus).toBe('unpaid');
  });

  it('refuses a payment that agrees about the order and disagrees about the money', async () => {
    const placed = await checkout(A.slug, productA);
    const paymentId = bankPayment({
      reference: `order:${A.slug}:${String(placed.number)}`,
      amountMinor: 1,
    });
    expect((await settle(A.slug, placed.orderId, paymentId)).statusCode).toBe(409);
    expect((await orderFromStaffApi(staffTokenA, placed.orderId)).paymentStatus).toBe('unpaid');
  });

  it("another tenant's order id is a 404, not a cross-tenant write (BE1)", async () => {
    const mine = await checkout(B.slug, productB);
    const paymentId = bankPayment({
      reference: `order:${B.slug}:${String(mine.number)}`,
      amountMinor: 2500,
    });
    // Right payment, right order -- asked for through the WRONG tenant's route.
    const res = await settle(A.slug, mine.orderId, paymentId);
    expect(res.statusCode).toBe(404);
  });

  it('records a declined payment as declined, and leaves the order standing', async () => {
    const placed = await checkout(A.slug, productA);
    const paymentId = bankPayment({
      reference: `order:${A.slug}:${String(placed.number)}`,
      amountMinor: 2500,
      status: 'declined',
    });
    expect((await settle(A.slug, placed.orderId, paymentId)).statusCode).toBe(200);

    const order = await orderFromStaffApi(staffTokenA, placed.orderId);
    expect(order.paymentStatus).toBe('declined');
    // Declined is not cancelled. The order exists; the money did not arrive.
    expect(order.status).toBe('placed');
  });

  it('a payment the bank has never heard of is a 404', async () => {
    const placed = await checkout(A.slug, productA);
    expect((await settle(A.slug, placed.orderId, randomUUID())).statusCode).toBe(404);
  });

  it('leaves the order alone while the bank still says "created"', async () => {
    const placed = await checkout(A.slug, productA);
    const paymentId = bankPayment({
      reference: `order:${A.slug}:${String(placed.number)}`,
      amountMinor: 2500,
      status: 'created',
    });
    const res = await settle(A.slug, placed.orderId, paymentId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ paymentStatus: 'unpaid' });
  });
});
