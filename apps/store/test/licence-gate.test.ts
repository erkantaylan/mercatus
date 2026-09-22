/**
 * The gate, against a real database (CG3, BUILD-PLAN §9: "passive licence returns 402 and the
 * dashboard still answers 200").
 *
 * The named test is the second half of that sentence, not the first. Anyone can make a checkout
 * fail; the design claim is that making it fail leaves the merchant every screen they need to
 * fix it -- and that the two reasons a checkout can be refused are two codes, because collapsing
 * them makes our outage look like being cut off for non-payment.
 *
 * Brings its own Postgres, exactly as api.test.ts does. These nine cases were among the 24 that
 * a `DATABASE_URL`-gated `describe.runIf` silently skipped inside a green `pnpm -r test`, which
 * is how a licence gate stops being exercised without anyone deleting a line of it.
 *
 *   pnpm --filter @mercatus/store test
 */
import { randomUUID } from 'node:crypto';

import type { StoreConfig } from '@mercatus/core';
import { loadStoreConfig } from '@mercatus/core';
import type { StoreDbHandle } from '@mercatus/db-store';
import {
  createStoreDb,
  ensureOrderCounter,
  insertProduct,
  mirrorTenant,
  recordLicenceSuccess,
  withExplicitTenantTx,
} from '@mercatus/db-store';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { StoreApp } from '../src/app.js';
import { buildStoreApp } from '../src/app.js';

let appUrl = '';

const T = { id: randomUUID(), slug: `lic-${randomUUID().slice(0, 8)}` };

let store: StoreApp | undefined;
let admin: StoreDbHandle | undefined;
let staffToken = '';
let shopperToken = '';
let productId = '';

/**
 * A five-second poll and a sixty-second grace window: the laptop profile from AppHost A, so the
 * numbers under test are the numbers the demo runs on.
 */
function config(): StoreConfig {
  return loadStoreConfig({
    DATABASE_URL: appUrl,
    AUTH_STUB_SECRET: 'test-stub-secret-that-is-long-enough',
    DEPLOYMENT_MODE: 'pooled',
    LICENCE_POLL_SECONDS: '5',
    LICENCE_GRACE_SECONDS: '60',
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
  });
}

/**
 * Write what a poll would have written, at a chosen age. The agent itself is not under test here
 * -- what is under test is what the rest of the store does with the row it leaves behind.
 */
async function licence(
  status: 'active' | 'passive',
  lastSuccessSecondsAgo: number,
  entitlements: Record<string, boolean> = {},
): Promise<void> {
  const at = new Date(Date.now() - lastSuccessSecondsAgo * 1000);
  await withExplicitTenantTx(admin!.db, T.id, async (tx) => {
    await recordLicenceSuccess(tx, T.id, { status, entitlements, validUntil: '2030-01-01' });
    // recordLicenceSuccess stamps `now()`; the AGE is the whole point of this test, so it is
    // backdated afterwards rather than by threading a clock through the repository.
    await tx.execute(
      sql`update licence_state set last_success_at = ${at.toISOString()}::timestamptz`,
    );
  });
}

beforeAll(async () => {
  const urls = inject('storeDb');
  appUrl = urls.appUrl;
  admin = createStoreDb(urls.adminUrl, { max: 2 });
  await withExplicitTenantTx(admin.db, T.id, async (tx) => {
    await mirrorTenant(tx, { id: T.id, slug: T.slug, name: T.slug });
    await ensureOrderCounter(tx, T.id);
    const product = await insertProduct(tx, T.id, {
      sku: 'LIC-1',
      title: 'A thing to buy',
      priceMinor: 1000,
      stock: 50,
    });
    productId = product.id;
  });

  store = await buildStoreApp(config());
  await store.app.ready();

  const staff = await store.app.inject({
    method: 'POST',
    url: '/dev/login/staff',
    payload: { slug: T.slug, role: 'owner' },
  });
  staffToken = (staff.json() as { accessToken: string }).accessToken;

  const shopper = await store.app.inject({
    method: 'POST',
    url: '/dev/login/shopper',
    payload: { phone: '+905550009999' },
  });
  shopperToken = (shopper.json() as { accessToken: string }).accessToken;
}, 60_000);

afterAll(async () => {
  await store?.close();
  await admin?.close();
});

function checkout() {
  return store!.app.inject({
    method: 'POST',
    url: `/t/${T.slug}/checkout`,
    headers: { authorization: `Bearer ${shopperToken}` },
    payload: { lines: [{ productId, qty: 1 }], shopper: { phone: '+905550009999' } },
  });
}

function staffWrite() {
  return store!.app.inject({
    method: 'POST',
    url: '/api/products',
    headers: { authorization: `Bearer ${staffToken}` },
    payload: { sku: `W-${randomUUID().slice(0, 8)}`, title: 'Added', priceMinor: 100, stock: 1 },
  });
}

function staffRead() {
  return store!.app.inject({
    method: 'GET',
    url: '/api/products',
    headers: { authorization: `Bearer ${staffToken}` },
  });
}

function browse() {
  return store!.app.inject({ method: 'GET', url: `/t/${T.slug}/products` });
}

describe('the licence gate', () => {
  it('sells, serves and writes while the licence is active and fresh', async () => {
    await licence('active', 0);
    expect((await checkout()).statusCode).toBe(201);
    expect((await staffWrite()).statusCode).toBe(201);
    expect((await browse()).statusCode).toBe(200);
  });

  it('PASSIVE: checkout is 402 and the dashboard is untouched -- reads AND writes', async () => {
    await licence('passive', 0);
    const refused = await checkout();
    expect(refused.statusCode).toBe(402);
    expect(refused.json()).toMatchObject({ error: { code: 'LICENCE_PASSIVE' } });

    // The half of the rule that matters. The merchant keeps the page that fixes this.
    expect((await staffRead()).statusCode).toBe(200);
    expect((await staffWrite()).statusCode).toBe(201);
    expect((await browse()).statusCode).toBe(200);
  });

  it('tells a shopper the shop is not selling, without saying it is our fault', async () => {
    await licence('passive', 0);
    const branding = await store!.app.inject({ method: 'GET', url: `/t/${T.slug}/branding` });
    expect(branding.json()).toMatchObject({ licence: { checkout: 'blocked_passive' } });
  });

  it('GRACE: unreachable inside the window refuses nothing at all (CG1)', async () => {
    await licence('active', 30);
    expect((await checkout()).statusCode).toBe(201);
    expect((await staffWrite()).statusCode).toBe(201);
    expect((await browse()).statusCode).toBe(200);
  });

  it('READ_ONLY: past the window, 503 on checkout and on writes -- reads keep working', async () => {
    await licence('active', 3600);
    const refused = await checkout();
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({ error: { code: 'CONTROL_PLANE_UNREACHABLE' } });

    const write = await staffWrite();
    expect(write.statusCode).toBe(503);
    expect(write.json()).toMatchObject({ error: { code: 'CONTROL_PLANE_UNREACHABLE' } });

    // Never a hard stop. Browsing and the merchant's own data are still there.
    expect((await browse()).statusCode).toBe(200);
    expect((await staffRead()).statusCode).toBe(200);
  });

  it('never reports a passive STATUS because we were unreachable (CG3)', async () => {
    await licence('active', 3600);
    const view = await store!.app.inject({
      method: 'GET',
      url: '/api/licence',
      headers: { authorization: `Bearer ${staffToken}` },
    });
    expect(view.json()).toMatchObject({ status: 'active', state: 'read_only' });
  });

  it('gates the "powered by" mark on the entitlement, with no rebuild (CC3)', async () => {
    await licence('active', 0);
    const on = await store!.app.inject({ method: 'GET', url: `/t/${T.slug}/branding` });
    expect(on.json()).toMatchObject({ licence: { poweredByMark: true } });

    await licence('active', 0, { whiteLabel: true });
    const off = await store!.app.inject({ method: 'GET', url: `/t/${T.slug}/branding` });
    expect(off.json()).toMatchObject({ licence: { poweredByMark: false } });
  });
});
