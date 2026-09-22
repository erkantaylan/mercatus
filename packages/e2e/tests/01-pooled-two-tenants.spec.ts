/**
 * The demo, part one: one shopper, one sign-in, two merchants, and two merchants who cannot see
 * each other.
 *
 * This is the acceptance criteria written as a test, in the order a person would do it:
 *
 *   1. a shopper signs in ONCE, at the storefront, not at a store
 *   2. buys from pooled tenant `acme`
 *   3. buys from pooled tenant `borg` with the same account, without being asked who they are
 *   4. acme's merchant sees acme's order in their own dashboard, and borg's is not there
 *   5. borg's merchant sees borg's order, and acme's is not there
 *
 * Both stores are ONE process and ONE database (BUILD-PLAN §8.1: store-pooled on 4002). The
 * separation is Postgres row-level security keyed on the tenant in the transaction (BE1), and the
 * shopper's own list is scoped by route-tenant AND token-subject together (BI2) -- which is what
 * makes "the same account at both shops" safe to have at all.
 *
 * ONE browser context for the whole file, created in `beforeAll` rather than taken from the `page`
 * fixture. Playwright gives each test a fresh context, and a fresh context is a fresh cookie jar --
 * which would make "signs in once" a sentence rather than a fact. Serial, because it is a story.
 */
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import {
  addToBasket,
  checkout,
  shot,
  signedInAs,
  signIn,
  signInToDashboard,
  signOutOfDashboard,
} from './helpers/shop.js';
import { ENDPOINTS, TENANTS, staffOrderCount } from './helpers/stack.js';

const SHOPPER = { phone: '+905550000777', name: 'E2E Shopper' };

/** Named products, so an assertion says which merchant's stock it is looking at. */
const ACME_PRODUCT = 'Rocket Skates';
const BORG_PRODUCT = 'Ocular Implant';

interface Placed {
  readonly orderId: string;
  readonly number: number;
}

const bought: { acme?: Placed; borg?: Placed } = {};

let context: BrowserContext;
let page: Page;

test.describe.configure({ mode: 'serial' });

test.describe('one shopper, two pooled merchants', () => {
  test.beforeAll(async ({ browser }) => {
    // Order numbers are per-tenant and gapless, so "the first order is 1" is an assertion about a
    // FRESH stack. Saying so here turns a re-run into one clear sentence instead of
    // `expected 2 to be 1` three tests later.
    const placed =
      (await staffOrderCount(ENDPOINTS.storePooled, TENANTS.acme.slug)) +
      (await staffOrderCount(ENDPOINTS.storePooled, TENANTS.borg.slug));
    expect(
      placed,
      'this suite asserts per-tenant order numbering and needs a freshly started AppHost A ' +
        '(`aspire stop` then `aspire run --detach` in aspire/AppHostA)',
    ).toBe(0);

    context = await browser.newContext();
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await context.close();
  });

  test('a shopper signs in once, for every store on the platform', async () => {
    await signIn(page, ENDPOINTS.storefront, SHOPPER);
    await shot(page, '01-signed-in');

    // The session is tenant-less, so the store shell shows the same account on both shops before
    // a single order exists at either.
    await page.goto(`${ENDPOINTS.storefront}/t/${TENANTS.acme.slug}`);
    expect(await signedInAs(page)).toBe(SHOPPER.phone);
    await page.goto(`${ENDPOINTS.storefront}/t/${TENANTS.borg.slug}`);
    expect(await signedInAs(page)).toBe(SHOPPER.phone);
  });

  test('buys from pooled tenant acme', async () => {
    await addToBasket(page, ENDPOINTS.storefront, TENANTS.acme.slug, ACME_PRODUCT);
    await shot(page, '02-acme-catalog');

    const purchase = await checkout(page, ENDPOINTS.storefront, TENANTS.acme.slug);
    expect(purchase.payment).toBe('paid');
    // Per-tenant, gapless numbering from acme's own counter, never a global sequence (BG2).
    expect(purchase.number).toBe(1);
    await shot(page, '03-acme-order-paid');
    bought.acme = purchase;
  });

  test('buys from pooled tenant borg with the SAME account, and is not asked to sign in again', async () => {
    await page.goto(`${ENDPOINTS.storefront}/t/${TENANTS.borg.slug}`);
    expect(await signedInAs(page)).toBe(SHOPPER.phone);

    await addToBasket(page, ENDPOINTS.storefront, TENANTS.borg.slug, BORG_PRODUCT);

    // The checkout page offers no phone field at all: the httpOnly cookie is the identity.
    await page.goto(`${ENDPOINTS.storefront}/t/${TENANTS.borg.slug}/checkout`);
    await expect(page.locator(`.sf-card [data-shopper="${SHOPPER.phone}"]`)).toBeVisible();
    await expect(page.locator('#phone')).toHaveCount(0);
    await shot(page, '04-borg-checkout-same-account');

    const purchase = await checkout(page, ENDPOINTS.storefront, TENANTS.borg.slug);
    expect(purchase.payment).toBe('paid');
    // Borg's FIRST order is also 1. Same process, same database, separate counters (BG2).
    expect(purchase.number).toBe(1);
    await shot(page, '05-borg-order-paid');
    bought.borg = purchase;
  });

  test('one account, one order at each shop', async () => {
    await page.goto(`${ENDPOINTS.storefront}/t/${TENANTS.acme.slug}/orders`);
    await expect(page.getByRole('link', { name: '#1' })).toBeVisible();
    await expect(page.locator('.sf-page-header')).toContainText('1 orders at this store');
    await shot(page, '06-shopper-orders-acme');

    await page.goto(`${ENDPOINTS.storefront}/t/${TENANTS.borg.slug}/orders`);
    await expect(page.getByRole('link', { name: '#1' })).toBeVisible();
    await expect(page.locator('.sf-page-header')).toContainText('1 orders at this store');
    await shot(page, '07-shopper-orders-borg');

    // Same browser, same cookie, and the order ids are different rows in two different tenants.
    expect(bought.acme?.orderId).not.toBe(bought.borg?.orderId);
  });

  test("acme's merchant sees acme's order, and cannot reach borg's", async () => {
    const borgOrderId = bought.borg?.orderId ?? '';
    expect(borgOrderId).not.toBe('');

    await signInToDashboard(page, ENDPOINTS.dashboard, TENANTS.acme.slug);
    await page.goto(`${ENDPOINTS.dashboard}/orders`);
    await expect(page.locator('table tbody tr')).toHaveCount(1);
    await shot(page, '08-dashboard-acme-orders');

    await page.getByRole('link', { name: 'Lines' }).click();
    await expect(page.locator('table')).toContainText(ACME_PRODUCT);
    await expect(page.locator('table')).not.toContainText(BORG_PRODUCT);

    // Borg's order id, asked for with acme's tenant-scoped token. RLS makes the row invisible
    // inside acme's transaction, so the API answers 404 -- not 403, which would confirm it
    // exists (S1).
    await page.goto(`${ENDPOINTS.dashboard}/orders/${borgOrderId}`);
    await expect(page.getByText('Not found.')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(BORG_PRODUCT);
    await shot(page, '09-dashboard-acme-cannot-see-borg');
  });

  test("borg's merchant sees borg's order, and cannot reach acme's", async () => {
    const acmeOrderId = bought.acme?.orderId ?? '';
    expect(acmeOrderId).not.toBe('');

    await page.goto(`${ENDPOINTS.dashboard}/orders`);
    await signOutOfDashboard(page);
    await signInToDashboard(page, ENDPOINTS.dashboard, TENANTS.borg.slug);

    await page.goto(`${ENDPOINTS.dashboard}/orders`);
    await expect(page.locator('table tbody tr')).toHaveCount(1);
    await page.getByRole('link', { name: 'Lines' }).click();
    await expect(page.locator('table')).toContainText(BORG_PRODUCT);
    await expect(page.locator('table')).not.toContainText(ACME_PRODUCT);
    await shot(page, '10-dashboard-borg-orders');

    await page.goto(`${ENDPOINTS.dashboard}/orders/${acmeOrderId}`);
    await expect(page.getByText('Not found.')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(ACME_PRODUCT);
    await shot(page, '11-dashboard-borg-cannot-see-acme');
  });
});
