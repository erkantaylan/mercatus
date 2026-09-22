/**
 * The task-03 gate, mechanised (BL1, BUILD-PLAN §9).
 *
 * The curl transcript in `diary/03-store-api.md` proves it once; this proves it on every run. It
 * boots the real app against a real Postgres and drives it through `inject()`, because the thing
 * under test is the whole pipeline -- token, tenant decision, transaction, RLS -- and a unit test
 * of any one layer would assert the parts that were never in doubt.
 *
 * What it holds down:
 *   - a product created by one merchant is INVISIBLE to another: empty list, 404 by id, and 404
 *     on update and delete (BE1)
 *   - a shopper's orders at one store are not their orders at another (BI2)
 *   - a staff token plus another merchant's URL is a refusal, not a switch (BI1)
 *   - a shopper token cannot reach the staff surface and vice versa (BH1)
 *
 * Needs a live Postgres, migrated. DATABASE_ADMIN_URL is needed only to create the two fixture
 * tenants, which is an owner's job -- the app role holds SELECT on `tenants` and nothing more:
 *
 *   DATABASE_SUPERUSER_URL=... DATABASE_ADMIN_URL=... pnpm --filter @mercatus/db-store migrate
 *   DATABASE_URL=... DATABASE_ADMIN_URL=... pnpm --filter @mercatus/store test
 */
import { randomUUID } from 'node:crypto';

import type { StoreConfig } from '@mercatus/core';
import { loadStoreConfig } from '@mercatus/core';
import type { StoreDbHandle } from '@mercatus/db-store';
import { createStoreDb, ensureOrderCounter, mirrorTenant, withExplicitTenantTx } from '@mercatus/db-store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { StoreApp } from '../src/app.js';
import { buildStoreApp } from '../src/app.js';

const appUrl = process.env['DATABASE_URL'];
const adminUrl = process.env['DATABASE_ADMIN_URL'];
const hasDb = Boolean(appUrl && adminUrl);

if (!hasDb) {
  // A skipped suite nobody notices is how an isolation guarantee quietly stops being true.
  process.stderr.write(
    '\n[api.test] SKIPPED: DATABASE_URL and DATABASE_ADMIN_URL are not set, so the store API ' +
      'suite did not run. See the header of this file.\n\n',
  );
}

const A = { id: randomUUID(), slug: `api-a-${randomUUID().slice(0, 8)}` };
const B = { id: randomUUID(), slug: `api-b-${randomUUID().slice(0, 8)}` };

let store: StoreApp | undefined;
let admin: StoreDbHandle | undefined;
let tokenA = '';
let tokenB = '';
let shopperToken = '';
let productA = '';

function config(): StoreConfig {
  return loadStoreConfig({
    DATABASE_URL: appUrl,
    AUTH_STUB_SECRET: 'test-stub-secret-that-is-long-enough',
    DEPLOYMENT_MODE: 'pooled',
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
  });
}

async function devLoginStaff(slug: string): Promise<string> {
  const res = await store!.app.inject({
    method: 'POST',
    url: '/dev/login/staff',
    payload: { slug, role: 'owner' },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { accessToken: string }).accessToken;
}

beforeAll(async () => {
  if (!hasDb) return;
  admin = createStoreDb(adminUrl!, { max: 2 });
  for (const tenant of [A, B]) {
    await withExplicitTenantTx(admin.db, tenant.id, async (tx) => {
      await mirrorTenant(tx, { id: tenant.id, slug: tenant.slug, name: tenant.slug });
      await ensureOrderCounter(tx, tenant.id);
    });
  }

  store = await buildStoreApp(config());
  await store.app.ready();

  tokenA = await devLoginStaff(A.slug);
  tokenB = await devLoginStaff(B.slug);

  const shopper = await store.app.inject({
    method: 'POST',
    url: '/dev/login/shopper',
    payload: { phone: '+905550001234' },
  });
  shopperToken = (shopper.json() as { accessToken: string }).accessToken;
}, 60_000);

afterAll(async () => {
  await store?.close();
  await admin?.close();
});

describe.runIf(hasDb)('the store API', () => {
  it('reports its version and mode without a tenant or a token', async () => {
    const res = await store!.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', mode: 'pooled', tenant: null });
  });

  it('creates a product for merchant A', async () => {
    const res = await store!.app.inject({
      method: 'POST',
      url: '/api/products',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { sku: 'API-001', title: 'A widget', priceMinor: 1999, stock: 7 },
    });
    expect(res.statusCode).toBe(201);
    productA = (res.json() as { id: string }).id;
    expect(productA).toBeTruthy();
  });

  it('shows it to A', async () => {
    const res = await store!.app.inject({
      method: 'GET',
      url: '/api/products',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.json()).toMatchObject({ total: 1 });
  });

  it('shows B an EMPTY catalog, not A’s -- the whole point of BE1', async () => {
    const res = await store!.app.inject({
      method: 'GET',
      url: '/api/products',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], total: 0 });
  });

  it('answers 404, not 403, when B asks for A’s product by id', async () => {
    const res = await store!.app.inject({
      method: 'GET',
      url: `/api/products/${productA}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'PRODUCT_NOT_FOUND' } });
  });

  it('refuses B’s update and delete of A’s product, and leaves it untouched', async () => {
    const patched = await store!.app.inject({
      method: 'PATCH',
      url: `/api/products/${productA}`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { priceMinor: 1 },
    });
    expect(patched.statusCode).toBe(404);

    const deleted = await store!.app.inject({
      method: 'DELETE',
      url: `/api/products/${productA}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(deleted.statusCode).toBe(404);

    const still = await store!.app.inject({
      method: 'GET',
      url: `/api/products/${productA}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(still.json()).toMatchObject({ priceMinor: 1999, stock: 7 });
  });

  it('rejects an unknown key in a PATCH body rather than silently ignoring it', async () => {
    const res = await store!.app.inject({
      method: 'PATCH',
      url: `/api/products/${productA}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { titel: 'typo' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('refuses a staff route with no token, and with a shopper’s token (BH1)', async () => {
    const anonymous = await store!.app.inject({ method: 'GET', url: '/api/products' });
    expect(anonymous.statusCode).toBe(401);

    const shopper = await store!.app.inject({
      method: 'GET',
      url: '/api/products',
      headers: { authorization: `Bearer ${shopperToken}` },
    });
    expect(shopper.statusCode).toBe(403);
  });

  it('refuses A’s token on B’s URL -- a mismatch is never a switch (BI1)', async () => {
    const res = await store!.app.inject({
      method: 'GET',
      url: `/t/${B.slug}/products`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'TENANT_MISMATCH' } });
  });

  it('serves the public catalog of whichever store the URL names', async () => {
    const a = await store!.app.inject({ method: 'GET', url: `/t/${A.slug}/products` });
    expect(a.json()).toMatchObject({ total: 1 });
    const b = await store!.app.inject({ method: 'GET', url: `/t/${B.slug}/products` });
    expect(b.json()).toEqual({ items: [], total: 0 });
  });

  it('takes an order, decrements stock and numbers it from 1', async () => {
    const res = await store!.app.inject({
      method: 'POST',
      url: `/t/${A.slug}/checkout`,
      headers: { authorization: `Bearer ${shopperToken}` },
      payload: {
        lines: [{ productId: productA, qty: 2 }],
        shopper: { phone: '+905550001234', name: 'Test Shopper' },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ number: 1, totalMinor: 3998 });

    const product = await store!.app.inject({
      method: 'GET',
      url: `/api/products/${productA}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(product.json()).toMatchObject({ stock: 5 });
  });

  it('refuses a checkout at B carrying A’s product id', async () => {
    const res = await store!.app.inject({
      method: 'POST',
      url: `/t/${B.slug}/checkout`,
      headers: { authorization: `Bearer ${shopperToken}` },
      payload: { lines: [{ productId: productA, qty: 1 }], shopper: { phone: '+905550001234' } },
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses more than there is in stock', async () => {
    const res = await store!.app.inject({
      method: 'POST',
      url: `/t/${A.slug}/checkout`,
      headers: { authorization: `Bearer ${shopperToken}` },
      payload: { lines: [{ productId: productA, qty: 9999 }], shopper: { phone: '+905550001234' } },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'INSUFFICIENT_STOCK' } });
  });

  it('gives the shopper their order at A and nothing at B (BI2)', async () => {
    const atA = await store!.app.inject({
      method: 'GET',
      url: `/t/${A.slug}/orders`,
      headers: { authorization: `Bearer ${shopperToken}` },
    });
    expect(atA.json()).toMatchObject({ total: 1 });

    const atB = await store!.app.inject({
      method: 'GET',
      url: `/t/${B.slug}/orders`,
      headers: { authorization: `Bearer ${shopperToken}` },
    });
    expect(atB.json()).toEqual({ items: [], total: 0 });
  });

  it('shows the order to A’s staff and not to B’s', async () => {
    const a = await store!.app.inject({
      method: 'GET',
      url: '/api/orders',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(a.json()).toMatchObject({ total: 1 });

    const b = await store!.app.inject({
      method: 'GET',
      url: '/api/orders',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(b.json()).toEqual({ items: [], total: 0 });
  });

  it('numbers B’s first order 1 as well (BG2)', async () => {
    const product = await store!.app.inject({
      method: 'POST',
      url: '/api/products',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { sku: 'API-001', title: 'B widget', priceMinor: 500, stock: 3 },
    });
    // The same SKU as A's: (tenant_id, sku) is the composite unique, never a global one (BG1).
    expect(product.statusCode).toBe(201);

    const res = await store!.app.inject({
      method: 'POST',
      url: `/t/${B.slug}/checkout`,
      headers: { authorization: `Bearer ${shopperToken}` },
      payload: {
        lines: [{ productId: (product.json() as { id: string }).id, qty: 1 }],
        shopper: { phone: '+905550001234' },
      },
    });
    expect(res.json()).toMatchObject({ number: 1, totalMinor: 500 });
  });

  it('answers 404 for an unknown store', async () => {
    const res = await store!.app.inject({ method: 'GET', url: '/t/no-such-store/products' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'TENANT_NOT_FOUND' } });
  });
});
