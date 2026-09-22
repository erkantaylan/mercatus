/**
 * The task-04a gate, mechanised (BUILD-PLAN §9).
 *
 * The curl transcript in `diary/04a-platform-control-plane.md` proves it once; this proves it on
 * every run. It boots the real app against a real Postgres and drives it through `inject()`,
 * because the thing under test is the whole pipeline -- signature, transaction, status machine,
 * credential -- and a unit test of any one layer would assert the parts that were never in doubt.
 *
 * fake-bank is the single stub: the bank is somebody else's process, and the HMAC it would verify
 * is tested directly instead.
 *
 * What it holds down:
 *   - signup CREATES a pending tenant; only a signed callback ACTIVATES it (Q13)
 *   - a forged callback, and one that disagrees with its own payment, change nothing (CR1)
 *   - the callback is idempotent by provider_ref (CK2)
 *   - the licence verifies with the published public key and NOTHING ELSE (CG1)
 *   - a bootstrap token is one-time; an instance token reads its own tenant and no other (CE1)
 *   - a merchant's staff token is not an operator token (BH1)
 *
 * Needs a live Postgres, migrated:
 *   DATABASE_SUPERUSER_URL=... DATABASE_ADMIN_URL=... pnpm --filter @mercatus/db-platform migrate
 *   PLATFORM_DATABASE_URL=... pnpm --filter @mercatus/platform test
 *
 * PLATFORM_DATABASE_URL, not DATABASE_URL: `pnpm check` runs every package's suite in one
 * process tree, and the data plane's suites want the `store` database in DATABASE_URL at the
 * same moment this one wants `platform`. One variable cannot be both. It falls back to
 * DATABASE_URL when only this package is being run, and it is declared in turbo.json's `test`
 * task -- a variable turbo does not know about is a suite that skips while the run stays green
 * (lessons/03).
 */
import { randomUUID } from 'node:crypto';

import { StubAuthAdapter } from '@mercatus/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PlatformApp } from '../src/app.js';
import { buildPlatformApp } from '../src/app.js';
import type { BankClient } from '../src/bank.js';
import type { PlatformConfig } from '../src/config.js';
import { loadPlatformConfig } from '../src/config.js';
import { verifyLicenceToken } from '../src/licence.js';
import { signCallback } from '../src/signature.js';

const databaseUrl = process.env['PLATFORM_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const hasDb = Boolean(databaseUrl);

if (!hasDb) {
  // A skipped suite nobody notices is how a control plane quietly stops being exercised.
  process.stderr.write(
    '\n[platform.test] SKIPPED: neither PLATFORM_DATABASE_URL nor DATABASE_URL is set, so the ' +
      'control-plane suite did not run. See the header of this file.\n\n',
  );
}

const STUB_SECRET = 'test-stub-secret-that-is-long-enough';
const BANK_SECRET = 'test-fake-bank-hmac-secret-at-least-32-chars';
const PRICE = 49_900;

function config(): PlatformConfig {
  return loadPlatformConfig({
    DATABASE_URL: databaseUrl,
    AUTH_STUB_SECRET: STUB_SECRET,
    FAKE_BANK_HMAC_SECRET: BANK_SECRET,
    STORE_PLAN_PRICE_MINOR: String(PRICE),
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
  });
}

/** fake-bank, standing still. Its own behaviour is apps/fake-bank's suite, not this one. */
function stubBank(): BankClient & { refs: string[] } {
  const refs: string[] = [];
  return {
    refs,
    createPayment: (input) => {
      const providerRef = `fb_${input.reference}`;
      refs.push(providerRef);
      return Promise.resolve({ providerRef, paymentUrl: `http://bank.test/pay/${providerRef}` });
    },
  };
}

function callbackBody(providerRef: string, over: Partial<Record<string, unknown>> = {}) {
  const body = {
    providerRef,
    status: 'paid' as const,
    amountMinor: PRICE,
    currency: 'TRY',
    ...over,
  };
  return {
    ...body,
    signature: signCallback(BANK_SECRET, {
      providerRef: body.providerRef,
      status: body.status,
      amountMinor: body.amountMinor,
      currency: body.currency,
    }),
  };
}

let platform: PlatformApp | undefined;
let bank: ReturnType<typeof stubBank>;
let operator = '';
const slug = `zen-${randomUUID().slice(0, 8)}`;
let tenantId = '';
let instanceToken = '';
let licenceJwt = '';

async function signup(overrides: Record<string, unknown> = {}) {
  return platform!.app.inject({
    method: 'POST',
    url: '/signup',
    payload: {
      phone: `+9055500${String(Math.floor(Math.random() * 90_000) + 10_000)}`,
      name: 'Zeynep Buyer',
      storeName: 'Zenith Tools',
      slug,
      tier: 'dedicated',
      ...overrides,
    },
  });
}

beforeAll(async () => {
  if (!hasDb) return;
  bank = stubBank();
  platform = await buildPlatformApp(config(), { bank });
  await platform.app.ready();

  const login = await platform.app.inject({ method: 'POST', url: '/dev/login/operator', payload: {} });
  operator = (login.json() as { accessToken: string }).accessToken;
});

afterAll(async () => {
  await platform?.close();
});

describe.skipIf(!hasDb)('buy a store', () => {
  it('creates the tenant pending, with no licence and no activation date (Q13)', async () => {
    const res = await signup();
    expect(res.statusCode).toBe(201);
    tenantId = (res.json() as { tenantId: string }).tenantId;

    const tenant = await platform!.app.inject({
      method: 'GET',
      url: `/tenants/${slug}`,
      headers: { authorization: `Bearer ${operator}` },
    });
    expect(tenant.json()).toMatchObject({
      status: 'pending',
      tier: 'dedicated',
      activatedAt: null,
      licence: null,
    });
  });

  it('will not sign a licence for a tenant that has not got one', async () => {
    const res = await platform!.app.inject({
      method: 'GET',
      url: `/tenants/${slug}/licence/signed`,
      headers: { authorization: `Bearer ${operator}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses a callback whose signature does not verify (CR1, S1)', async () => {
    const res = await platform!.app.inject({
      method: 'POST',
      url: '/payments/callback',
      payload: { ...callbackBody(bank.refs[0]!), signature: 'deadbeef' },
    });
    expect(res.statusCode).toBe(401);
    // One generic code. It does not say whether the payment exists.
    expect(res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('refuses a correctly signed callback that disagrees with its own payment', async () => {
    const res = await platform!.app.inject({
      method: 'POST',
      url: '/payments/callback',
      payload: callbackBody(bank.refs[0]!, { amountMinor: 1 }),
    });
    expect(res.statusCode).toBe(409);
  });

  it('activates the tenant and issues the licence on the signed callback', async () => {
    const res = await platform!.app.inject({
      method: 'POST',
      url: '/payments/callback',
      payload: callbackBody(bank.refs[0]!),
    });
    expect(res.statusCode).toBe(204);

    const tenant = await platform!.app.inject({
      method: 'GET',
      url: `/tenants/${slug}`,
      headers: { authorization: `Bearer ${operator}` },
    });
    const body = tenant.json() as { status: string; activatedAt: string | null; licence: unknown };
    expect(body.status).toBe('active');
    expect(body.activatedAt).not.toBeNull();
    expect(body.licence).toMatchObject({ status: 'active', entitlements: {} });
  });

  it('is idempotent by provider_ref: the replay changes nothing (CK2)', async () => {
    const before = await platform!.app.inject({
      method: 'GET',
      url: `/tenants/${slug}`,
      headers: { authorization: `Bearer ${operator}` },
    });
    const res = await platform!.app.inject({
      method: 'POST',
      url: '/payments/callback',
      payload: callbackBody(bank.refs[0]!),
    });
    expect(res.statusCode).toBe(204);
    const after = await platform!.app.inject({
      method: 'GET',
      url: `/tenants/${slug}`,
      headers: { authorization: `Bearer ${operator}` },
    });
    expect(after.json()).toEqual(before.json());
  });

  it('resumes a pending tenant rather than colliding when a buyer retries', async () => {
    const other = `zen-${randomUUID().slice(0, 8)}`;
    const first = await signup({ slug: other });
    const second = await signup({ slug: other });
    expect(second.statusCode).toBe(201);
    expect((second.json() as { tenantId: string }).tenantId).toBe(
      (first.json() as { tenantId: string }).tenantId,
    );
  });

  it('refuses a second signup for a store that is already active', async () => {
    const res = await signup();
    expect(res.statusCode).toBe(409);
  });
});

describe.skipIf(!hasDb)('the signed licence', () => {
  it('verifies with the published public key and nothing else (CG1)', async () => {
    const signed = await platform!.app.inject({
      method: 'GET',
      url: `/tenants/${slug}/licence/signed`,
      headers: { authorization: `Bearer ${operator}` },
    });
    expect(signed.statusCode).toBe(200);
    licenceJwt = (signed.json() as { licence: string }).licence;

    const jwks = await platform!.app.inject({ method: 'GET', url: '/licence/jwks' });
    const key = (jwks.json() as { keys: Record<string, unknown>[] }).keys[0]!;

    const claims = await verifyLicenceToken(licenceJwt, key);
    expect(claims).toMatchObject({
      slug,
      tier: 'dedicated',
      status: 'active',
      sub: tenantId,
      iss: 'mercatus-platform',
      aud: 'mercatus-store',
    });
  });

  it('is asymmetric: the key set carries no private material (CE1)', async () => {
    const jwks = await platform!.app.inject({ method: 'GET', url: '/licence/jwks' });
    const key = (jwks.json() as { keys: Record<string, unknown>[] }).keys[0]!;
    expect(key['kty']).toBe('OKP');
    expect(key['crv']).toBe('Ed25519');
    // `d` is the private scalar. Publishing it would hand every VPS a licence printer.
    expect(key['d']).toBeUndefined();
  });

  it('refuses a tampered licence', async () => {
    const jwks = await platform!.app.inject({ method: 'GET', url: '/licence/jwks' });
    const key = (jwks.json() as { keys: Record<string, unknown>[] }).keys[0]!;
    const tampered = `${licenceJwt.slice(0, -4)}${licenceJwt.endsWith('AAAA') ? 'BBBB' : 'AAAA'}`;
    await expect(verifyLicenceToken(tampered, key)).rejects.toThrow();
  });
});

describe.skipIf(!hasDb)('installations', () => {
  let bootstrapToken = '';

  it('hands out a one-time bootstrap token and burns it on first use (CE1)', async () => {
    const created = await platform!.app.inject({
      method: 'POST',
      url: '/installations',
      headers: { authorization: `Bearer ${operator}` },
      payload: { tenantSlug: slug },
    });
    expect(created.statusCode).toBe(201);
    bootstrapToken = (created.json() as { bootstrapToken: string }).bootstrapToken;

    const registered = await platform!.app.inject({
      method: 'POST',
      url: '/installations/register',
      payload: { bootstrapToken, version: '1.0.0' },
    });
    expect(registered.statusCode).toBe(200);
    const body = registered.json() as { instanceToken: string; tenantSlug: string };
    instanceToken = body.instanceToken;
    expect(body.tenantSlug).toBe(slug);

    const again = await platform!.app.inject({
      method: 'POST',
      url: '/installations/register',
      payload: { bootstrapToken, version: '1.0.0' },
    });
    expect(again.statusCode).toBe(401);
  });

  it('refuses an installation for a pooled tenant', async () => {
    const res = await platform!.app.inject({
      method: 'POST',
      url: '/installations',
      headers: { authorization: `Bearer ${operator}` },
      payload: { tenantSlug: 'acme' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('records version, tenant and licence id on a heartbeat (CE6)', async () => {
    const licenceId = (
      (
        await platform!.app.inject({
          method: 'GET',
          url: `/tenants/${slug}/licence/signed`,
          headers: { authorization: `Bearer ${instanceToken}` },
        })
      ).json() as { licenceId: string }
    ).licenceId;

    const beat = await platform!.app.inject({
      method: 'POST',
      url: '/telemetry/heartbeat',
      headers: { authorization: `Bearer ${instanceToken}` },
      payload: { version: '1.0.0', tenantId, licenceId, productCount: 4, orderCount: 2 },
    });
    expect(beat.statusCode).toBe(204);

    const list = await platform!.app.inject({
      method: 'GET',
      url: '/installations',
      headers: { authorization: `Bearer ${operator}` },
    });
    const mine = (list.json() as { items: { tenantSlug: string }[] }).items.find(
      (i) => i.tenantSlug === slug,
    );
    expect(mine).toMatchObject({ version: '1.0.0', licenceId, productCount: 4, orderCount: 2 });
  });

  it('refuses a heartbeat that reports another tenant', async () => {
    const res = await platform!.app.inject({
      method: 'POST',
      url: '/telemetry/heartbeat',
      headers: { authorization: `Bearer ${instanceToken}` },
      payload: {
        version: '1.0.0',
        tenantId: randomUUID(),
        licenceId: null,
        productCount: 0,
        orderCount: 0,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses an instance reading another tenant's licence (BI1, through a credential)", async () => {
    const res = await platform!.app.inject({
      method: 'GET',
      url: '/tenants/acme/licence',
      headers: { authorization: `Bearer ${instanceToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe.skipIf(!hasDb)('the console flip (ES, CG3)', () => {
  it('sets passive, and the next poll and the next signed licence both say so', async () => {
    const flip = await platform!.app.inject({
      method: 'POST',
      url: `/tenants/${slug}/licence`,
      headers: { authorization: `Bearer ${operator}` },
      payload: { status: 'passive' },
    });
    expect(flip.statusCode).toBe(200);

    const poll = await platform!.app.inject({
      method: 'GET',
      url: `/tenants/${slug}/licence`,
      headers: { authorization: `Bearer ${instanceToken}` },
    });
    expect(poll.json()).toMatchObject({ status: 'passive' });

    const signed = await platform!.app.inject({
      method: 'GET',
      url: `/tenants/${slug}/licence/signed`,
      headers: { authorization: `Bearer ${instanceToken}` },
    });
    const jwks = await platform!.app.inject({ method: 'GET', url: '/licence/jwks' });
    const claims = await verifyLicenceToken(
      (signed.json() as { licence: string }).licence,
      (jwks.json() as { keys: Record<string, unknown>[] }).keys[0]!,
    );
    expect(claims['status']).toBe('passive');

    // Passive is not deletion and not a lost licence: the entitlements and the date survive it.
    expect(claims['validUntil']).toBeTruthy();
  });

  it('flips back to active', async () => {
    const res = await platform!.app.inject({
      method: 'POST',
      url: `/tenants/${slug}/licence`,
      headers: { authorization: `Bearer ${operator}` },
      payload: { status: 'active' },
    });
    expect(res.json()).toMatchObject({ status: 'active' });
  });

  it('refuses to flip a pending tenant, which has nothing to suspend', async () => {
    const pending = `zen-${randomUUID().slice(0, 8)}`;
    await platform!.app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${operator}` },
      payload: { slug: pending, name: 'Pending Co', tier: 'pooled' },
    });
    const res = await platform!.app.inject({
      method: 'POST',
      url: `/tenants/${pending}/licence`,
      headers: { authorization: `Bearer ${operator}` },
      payload: { status: 'passive' },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe.skipIf(!hasDb)('operator credentials (BH1)', () => {
  it('refuses the console with no token', async () => {
    const res = await platform!.app.inject({ method: 'GET', url: '/tenants' });
    expect(res.statusCode).toBe(401);
  });

  it("refuses the console with a MERCHANT's staff token", async () => {
    // The same secret, a different audience. Two apps, two audiences, no isStaff flag anywhere.
    const staff = await new StubAuthAdapter({ secret: STUB_SECRET, nodeEnv: 'test' }).issueStaffToken({
      subject: 'dev-staff:acme',
      tenantId: randomUUID(),
    });
    const res = await platform!.app.inject({
      method: 'GET',
      url: '/tenants',
      headers: { authorization: `Bearer ${staff}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses an instance token on a console route', async () => {
    const res = await platform!.app.inject({
      method: 'GET',
      url: '/tenants',
      headers: { authorization: `Bearer ${instanceToken}` },
    });
    expect(res.statusCode).toBe(401);
  });
});
