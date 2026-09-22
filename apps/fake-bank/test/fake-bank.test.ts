/**
 * The task-04b gate, mechanised. The curl transcript in `diary/04b-fake-bank.md` proves it once;
 * this proves it on every run.
 *
 * It boots the real app on a real port, and stands up a real HTTP server as the callback
 * receiver -- the platform's `POST /payments/callback` in miniature, verifying the signature the
 * same way the platform will have to. `inject()` is not used: `drop` destroys the socket, and
 * light-my-request's in-memory socket has nothing to destroy, so the one behaviour most worth
 * testing would be the one that could not be.
 *
 * Needs no database and no environment. Run: pnpm --filter @mercatus/fake-bank test
 */
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FakeBankApp } from '../src/app.js';
import { buildFakeBankApp } from '../src/app.js';
import { loadFakeBankConfig } from '../src/config.js';
import type { Behaviour } from '../src/contracts.js';
import { callbackCanonical, paymentRequestCanonical, sign, signatureMatches } from '../src/signing.js';

const SECRET = 'fake-bank-test-secret-at-least-32-chars';

interface ReceivedCallback {
  readonly body: Record<string, unknown>;
  readonly signatureValid: boolean;
}

let bank: FakeBankApp;
let bankUrl = '';
let receiver: Server;
let callbackUrl = '';
const received: ReceivedCallback[] = [];

function port(server: { address(): AddressInfo | string | null }): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('not listening on a port');
  return address.port;
}

beforeAll(async () => {
  // The platform's callback endpoint, reduced to the one thing that matters here: it verifies the
  // signature before it believes anything, and answers 401 when it does not match.
  receiver = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const expected = sign(
        SECRET,
        callbackCanonical({
          providerRef: String(body['providerRef']),
          status: String(body['status']),
          amountMinor: Number(body['amountMinor']),
          currency: String(body['currency']),
        }),
      );
      const signatureValid = signatureMatches(expected, String(body['signature']));
      received.push({ body, signatureValid });
      res.writeHead(signatureValid ? 204 : 401).end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  callbackUrl = `http://127.0.0.1:${port(receiver)}/payments/callback`;

  bank = await buildFakeBankApp(
    loadFakeBankConfig({
      MERCATUS_ALLOW_FAKE_BANK: '1',
      FAKE_BANK_HMAC_SECRET: SECRET,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    }),
  );
  await bank.app.listen({ port: 0, host: '127.0.0.1' });
  bankUrl = `http://127.0.0.1:${port(bank.app.server)}`;
});

afterAll(async () => {
  await bank?.close();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

interface OpenedPayment {
  readonly id: string;
  readonly providerRef: string;
  readonly paymentUrl: string;
}

async function open(options: { behaviour?: Behaviour; signature?: string } = {}): Promise<OpenedPayment> {
  const request = {
    amountMinor: 49_900,
    currency: 'TRY',
    reference: `tenant-${Math.random().toString(36).slice(2, 10)}`,
    callbackUrl,
  };
  const query = options.behaviour ? `?behaviour=${options.behaviour}` : '';
  const res = await fetch(`${bankUrl}/payments${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...request,
      signature: options.signature ?? sign(SECRET, paymentRequestCanonical(request)),
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as OpenedPayment;
}

async function complete(id: string, behaviour?: Behaviour): Promise<Response> {
  return fetch(`${bankUrl}/pay/${id}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(behaviour ? { behaviour } : {}),
  });
}

async function state(id: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${bankUrl}/payments/${id}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

function callbackFor(providerRef: string): ReceivedCallback | undefined {
  return received.find((entry) => entry.body['providerRef'] === providerRef);
}

describe('the run-mode gate', () => {
  it('refuses to load a config without MERCATUS_ALLOW_FAKE_BANK=1 (CR1)', () => {
    expect(() =>
      loadFakeBankConfig({ FAKE_BANK_HMAC_SECRET: SECRET }),
    ).toThrowError(/MERCATUS_ALLOW_FAKE_BANK/);
  });

  it('refuses a secret shorter than 32 characters', () => {
    expect(() =>
      loadFakeBankConfig({ MERCATUS_ALLOW_FAKE_BANK: '1', FAKE_BANK_HMAC_SECRET: 'short' }),
    ).toThrowError(/FAKE_BANK_HMAC_SECRET/);
  });
});

describe('our signature, verified before anything is answered (CR1)', () => {
  it('rejects a request whose signature does not match, and says what it hashed', async () => {
    const res = await fetch(`${bankUrl}/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        amountMinor: 1000,
        currency: 'TRY',
        reference: 'broken-hashing',
        callbackUrl,
        signature: 'deadbeef',
      }),
    });
    expect(res.status).toBe(401);
    const envelope = (await res.json()) as {
      error: { code: string; details: { canonical: string } };
    };
    expect(envelope.error.code).toBe('UNAUTHENTICATED');
    expect(envelope.error.details.canonical).toBe(
      `broken-hashing|1000|TRY|${callbackUrl}`,
    );
  });

  it('accepts a correctly signed request', async () => {
    const payment = await open();
    expect(payment.providerRef).toBe(`fb_${payment.id}`);
    expect(payment.paymentUrl).toBe(`${bankUrl}/pay/${payment.id}`);
  });
});

describe('the five behaviours', () => {
  it('approve: pays, and the callback verifies', async () => {
    const payment = await open();
    const res = await complete(payment.id, 'approve');
    expect(res.status).toBe(200);

    const after = await state(payment.id);
    expect(after['status']).toBe('paid');
    const callback = callbackFor(payment.providerRef);
    expect(callback?.signatureValid).toBe(true);
    expect(callback?.body['status']).toBe('paid');
    expect((after['callback'] as Record<string, unknown>)['httpStatus']).toBe(204);
  });

  it('decline: declines, and the callback still verifies', async () => {
    const payment = await open();
    expect((await complete(payment.id, 'decline')).status).toBe(200);

    const after = await state(payment.id);
    expect(after['status']).toBe('declined');
    const callback = callbackFor(payment.providerRef);
    expect(callback?.signatureValid).toBe(true);
    expect(callback?.body['status']).toBe('declined');
  });

  it('bad-hash: the callback arrives and is REFUSED by the receiver', async () => {
    const payment = await open();
    expect((await complete(payment.id, 'bad-hash')).status).toBe(200);

    const after = await state(payment.id);
    const attempt = after['callback'] as Record<string, unknown>;
    expect(attempt['attempted']).toBe(true);
    // Arrived, and was not believed. That distinction is the whole behaviour.
    expect(attempt['delivered']).toBe(false);
    expect(attempt['httpStatus']).toBe(401);
    expect(attempt['signatureCorrupted']).toBe(true);
    expect(callbackFor(payment.providerRef)?.signatureValid).toBe(false);
  });

  it('no-callback: the money is taken and we are never told', async () => {
    const payment = await open();
    expect((await complete(payment.id, 'no-callback')).status).toBe(200);

    const after = await state(payment.id);
    expect(after['status']).toBe('paid');
    expect((after['callback'] as Record<string, unknown>)['attempted']).toBe(false);
    expect(callbackFor(payment.providerRef)).toBeUndefined();
  });

  it('drop: the connection dies with no reply and no callback', async () => {
    const payment = await open();
    await expect(complete(payment.id, 'drop')).rejects.toThrow();

    const after = await state(payment.id);
    expect(after['status']).toBe('dropped');
    expect((after['callback'] as Record<string, unknown>)['attempted']).toBe(false);
    expect(callbackFor(payment.providerRef)).toBeUndefined();
  });
});

describe('selecting the behaviour', () => {
  it('defaults to approve when nobody says otherwise', async () => {
    const payment = await open();
    const res = await fetch(`${bankUrl}/pay/${payment.id}/complete`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await state(payment.id))['status']).toBe('paid');
  });

  it('uses ?behaviour= from the time the payment was opened', async () => {
    const payment = await open({ behaviour: 'decline' });
    expect((await complete(payment.id)).status).toBe(200);
    expect((await state(payment.id))['status']).toBe('declined');
  });

  it('lets the completion override the payment behaviour', async () => {
    const payment = await open({ behaviour: 'decline' });
    expect((await complete(payment.id, 'approve')).status).toBe(200);
    expect((await state(payment.id))['status']).toBe('paid');
  });

  it('refuses an unknown behaviour rather than falling back to approve', async () => {
    const payment = await open();
    const res = await fetch(`${bankUrl}/pay/${payment.id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ behaviour: 'refund' }),
    });
    expect(res.status).toBe(400);
    expect((await state(payment.id))['status']).toBe('created');
  });
});

describe('the rest of the surface', () => {
  it('serves the payment page as HTML with a button per behaviour', async () => {
    const payment = await open();
    const res = await fetch(payment.paymentUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    for (const behaviour of ['approve', 'decline', 'bad-hash', 'no-callback', 'drop']) {
      expect(html).toContain(`data-behaviour="${behaviour}"`);
    }
  });

  it('will not settle the same payment twice', async () => {
    const payment = await open();
    expect((await complete(payment.id, 'approve')).status).toBe(200);
    const second = await complete(payment.id, 'decline');
    expect(second.status).toBe(409);
    expect((await state(payment.id))['status']).toBe('paid');
  });

  it('404s an unknown payment', async () => {
    const res = await fetch(`${bankUrl}/payments/11111111-1111-4111-8111-111111111111`);
    expect(res.status).toBe(404);
  });

  it('answers /health', async () => {
    const res = await fetch(`${bankUrl}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toMatchObject({ status: 'ok' });
  });
});
