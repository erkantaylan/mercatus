/**
 * The demo, part two: a tenant flipped to PASSIVE blocks checkout and leaves the dashboard alone.
 *
 * That distinction is the whole of `CG3`, and it is the one people collapse: "licence says
 * inactive" and "we cannot reach the control plane" are two states with two behaviours. Passive is
 * the merchant's own status -- they did not pay, or we suspended them -- so it blocks the
 * money-making action and NOTHING else. The merchant can still read their catalogue, still see
 * their orders, still change things, and still reach the page that fixes it. Taking the dashboard
 * away from a merchant whose licence lapsed removes the path back.
 *
 * The flip is the platform console's own call (`POST /tenants/:slug/licence`), made from the
 * suite rather than by clicking, because a browser click here would be testing the console's
 * button and not the data plane's behaviour. The console is screenshotted showing the result.
 *
 * The store learns by POLLING, every `LICENCE_POLL_SECONDS` (5 in AppHost A), so every assertion
 * that follows the flip is a poll, not an instant.
 */
import { expect, test } from '@playwright/test';

import { shot, signInToDashboard } from './helpers/shop.js';
import {
  ENDPOINTS,
  TENANTS,
  licenceView,
  setTenantLicence,
  shopperCheckoutState,
  staffToken,
} from './helpers/stack.js';

const SLUG = TENANTS.acme.slug;

test.describe.configure({ mode: 'serial' });

test.describe('a passive tenant blocks checkout, not the dashboard', () => {
  test.afterAll(async () => {
    // Whatever happened above, leave the tenant sellable for whoever runs next.
    await setTenantLicence(SLUG, 'active');
    await expect
      .poll(() => shopperCheckoutState(ENDPOINTS.storePooled, SLUG), { timeout: 60_000 })
      .toBe('open');
  });

  test('flipping the licence to passive reaches the store within one poll', async () => {
    expect(await shopperCheckoutState(ENDPOINTS.storePooled, SLUG)).toBe('open');

    await setTenantLicence(SLUG, 'passive');

    await expect
      .poll(() => shopperCheckoutState(ENDPOINTS.storePooled, SLUG), { timeout: 60_000 })
      .toBe('blocked_passive');

    const view = await licenceView(ENDPOINTS.storePooled, SLUG);
    expect(view.status).toBe('passive');
    // `passive` is the tenant's status, not an outage of ours. The two are never one flag.
    expect(view.state).toBe('passive');
  });

  test('the storefront browses and refuses to check out', async ({ page }) => {
    await page.goto(`${ENDPOINTS.storefront}/t/${SLUG}`);
    // Browsing is untouched: the catalogue is there, with the banner above it.
    await expect(page.locator('article.sf-product').first()).toBeVisible();
    await expect(page.locator('.sf-banner')).toContainText('not taking orders');
    await shot(page, '12-storefront-passive-banner');

    await page.goto(`${ENDPOINTS.storefront}/t/${SLUG}/checkout`);
    await expect(page.getByRole('button', { name: /^Pay / })).toHaveCount(0);
    await expect(page.locator('.sf-muted')).toContainText('Your basket is kept');
    await shot(page, '13-storefront-passive-checkout');
  });

  test('the store API answers 402 to a checkout and 200 to the catalogue', async ({ request }) => {
    const products = await request.get(`${ENDPOINTS.storePooled}/t/${SLUG}/products`);
    expect(products.status()).toBe(200);

    const login = await request.post(`${ENDPOINTS.storePooled}/dev/login/shopper`, {
      data: { phone: '+905550000778' },
    });
    const { accessToken } = (await login.json()) as { accessToken: string };
    const catalogue = (await products.json()) as { items: { id: string }[] };
    const first = catalogue.items[0];
    expect(first).toBeTruthy();

    const refused = await request.post(`${ENDPOINTS.storePooled}/t/${SLUG}/checkout`, {
      headers: { authorization: `Bearer ${accessToken}` },
      data: { lines: [{ productId: first?.id, qty: 1 }], shopper: { phone: '+905550000778' } },
    });
    expect(refused.status()).toBe(402);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('LICENCE_PASSIVE');
  });

  test('the merchant dashboard is fully usable, writes included', async ({ page, request }) => {
    await signInToDashboard(page, ENDPOINTS.dashboard, SLUG);

    // The catalogue is the merchant's own data and it is all still there. Orders renders too --
    // asserted on the page rather than on a row count, because this spec must not depend on
    // whether an earlier one sold anything.
    await page.goto(`${ENDPOINTS.dashboard}/products`);
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await page.goto(`${ENDPOINTS.dashboard}/orders`);
    await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible();
    await expect(page.getByText('Could not load orders.')).toHaveCount(0);
    // The banner tells the merchant what is wrong; it does not take the screen away.
    await expect(page.locator('.mc-banner').first()).toBeVisible();
    await shot(page, '14-dashboard-passive-still-usable');

    // A WRITE, while passive. `writesRefused` is read_only only -- a dashboard the merchant can
    // read but not fix would be "fully usable" in name only.
    const token = await staffToken(ENDPOINTS.storePooled, SLUG);
    const created = await request.post(`${ENDPOINTS.storePooled}/api/products`, {
      headers: { authorization: `Bearer ${token}` },
      data: { sku: 'E2E-PASSIVE-1', title: 'Written while passive', priceMinor: 1000, stock: 1 },
    });
    expect(created.status()).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const removed = await request.delete(`${ENDPOINTS.storePooled}/api/products/${id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(removed.status()).toBe(200);
  });

  test('the platform console shows the tenant as passive', async ({ page }) => {
    await page.goto(`${ENDPOINTS.admin}/login`);
    await expect(async () => {
      await page.getByTestId('sign-in').click();
      await expect(page.getByTestId(`tenant-row-${SLUG}`)).toBeVisible({ timeout: 4000 });
    }).toPass({ timeout: 45_000 });

    await expect(page.getByTestId(`tenant-status-${SLUG}`)).toHaveText('passive');
    await shot(page, '15-admin-console-passive');
  });
});
