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
  freshShopper,
  shot,
  signedInAs,
  signIn,
  signInToDashboard,
  signOutOfDashboard,
} from './helpers/shop.js';
import { ENDPOINTS, TENANTS, sellableProduct, staffOrderCount } from './helpers/stack.js';

/**
 * A NEW shopper every run, and every count below is relative to what the stores already held.
 *
 * This file used to abort unless acme and borg had exactly zero orders between them, because it
 * asserted "the first order is 1". One demo purchase, or simply running the suite twice, then
 * failed it until both AppHosts were destroyed and rebuilt -- and the clear message about that
 * was immediately buried under a `Cannot read properties of undefined (reading 'close')` from an
 * afterAll touching a context beforeAll never created. Per-tenant gapless numbering is still the
 * claim; it is now written as "acme's next order number is acme's count plus one", which is the
 * same rule stated so it survives a second run.
 */
const SHOPPER = freshShopper('Shopper');

/**
 * One product per merchant, so an assertion can say whose stock it is looking at -- CHOSEN at run
 * time, not named here. This file buys one of acme's every run, and the run that took the last
 * `Rocket Skates` failed it on a stack that was perfectly healthy: the card loses its `Add to
 * basket` button and the click loop times out saying nothing useful. Filled in `beforeAll`.
 */
const product: { acme: string; borg: string } = { acme: '', borg: '' };

interface Placed {
  readonly orderId: string;
  readonly number: number;
}

const bought: { acme?: Placed; borg?: Placed } = {};

/** What each store already held before this run. Every assertion below is relative to these. */
const before = { acme: 0, borg: 0 };

let context: BrowserContext | undefined;
let page: Page;

test.describe.configure({ mode: 'serial' });

test.describe('one shopper, two pooled merchants', () => {
  test.beforeAll(async ({ browser }) => {
    before.acme = await staffOrderCount(ENDPOINTS.storePooled, TENANTS.acme.slug);
    before.borg = await staffOrderCount(ENDPOINTS.storePooled, TENANTS.borg.slug);
    product.acme = await sellableProduct(ENDPOINTS.storePooled, TENANTS.acme.slug);
    product.borg = await sellableProduct(ENDPOINTS.storePooled, TENANTS.borg.slug);

    context = await browser.newContext();
    page = await context.newPage();
  });

  test.afterAll(async () => {
    // Optional chaining, because a beforeAll that threw leaves this undefined and the resulting
    // TypeError hides the failure that actually mattered.
    await context?.close();
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
    await addToBasket(page, ENDPOINTS.storefront, TENANTS.acme.slug, product.acme);
    await shot(page, '02-acme-catalog');

    const purchase = await checkout(page, ENDPOINTS.storefront, TENANTS.acme.slug);
    expect(purchase.payment).toBe('paid');
    // Per-tenant, gapless numbering from acme's own counter, never a global sequence (BG2).
    // On a freshly started AppHost A that is 1.
    expect(purchase.number).toBe(before.acme + 1);
    await shot(page, '03-acme-order-paid');
    bought.acme = purchase;
  });

  test('buys from pooled tenant borg with the SAME account, and is not asked to sign in again', async () => {
    await page.goto(`${ENDPOINTS.storefront}/t/${TENANTS.borg.slug}`);
    expect(await signedInAs(page)).toBe(SHOPPER.phone);

    await addToBasket(page, ENDPOINTS.storefront, TENANTS.borg.slug, product.borg);

    // The checkout page offers no phone field at all: the httpOnly cookie is the identity.
    await page.goto(`${ENDPOINTS.storefront}/t/${TENANTS.borg.slug}/checkout`);
    await expect(page.locator(`.sf-card [data-shopper="${SHOPPER.phone}"]`)).toBeVisible();
    await expect(page.locator('#phone')).toHaveCount(0);
    await shot(page, '04-borg-checkout-same-account');

    const purchase = await checkout(page, ENDPOINTS.storefront, TENANTS.borg.slug);
    expect(purchase.payment).toBe('paid');
    // Borg counts from its OWN counter: on a fresh stack both stores' first order is 1. Same
    // process, same database, separate counters (BG2).
    expect(purchase.number).toBe(before.borg + 1);
    await shot(page, '05-borg-order-paid');
    bought.borg = purchase;
  });

  test('one account, one order at each shop', async () => {
    // A shopper minted for this run, so "1 order at this store" is about the PERSON and holds
    // however many orders the store already had (BI2: tenant from the route, subject from the
    // token, and this list is the subject half being visible).
    await page.goto(`${ENDPOINTS.storefront}/t/${TENANTS.acme.slug}/orders`);
    await expect(page.getByRole('link', { name: `#${String(before.acme + 1)}` })).toBeVisible();
    await expect(page.locator('.sf-page-header')).toContainText('1 orders at this store');
    await shot(page, '06-shopper-orders-acme');

    await page.goto(`${ENDPOINTS.storefront}/t/${TENANTS.borg.slug}/orders`);
    await expect(page.getByRole('link', { name: `#${String(before.borg + 1)}` })).toBeVisible();
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
    await expect(page.locator('table tbody tr')).toHaveCount(before.acme + 1);
    // The merchant can see that the money arrived. It used to live only in the storefront
    // process's memory, so a paid order and an abandoned one looked identical here.
    await expect(page.locator('table tbody tr').first().locator('[data-payment="paid"]')).toBeVisible();
    await shot(page, '08-dashboard-acme-orders');

    await page.getByRole('link', { name: 'Lines' }).first().click();
    await expect(page.locator('table')).toContainText(product.acme);
    await expect(page.locator('table')).not.toContainText(product.borg);

    // Borg's order id, asked for with acme's tenant-scoped token. RLS makes the row invisible
    // inside acme's transaction, so the API answers 404 -- not 403, which would confirm it
    // exists (S1).
    await page.goto(`${ENDPOINTS.dashboard}/orders/${borgOrderId}`);
    await expect(page.getByText('Not found.')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(product.borg);
    await shot(page, '09-dashboard-acme-cannot-see-borg');
  });

  test("borg's merchant sees borg's order, and cannot reach acme's", async () => {
    const acmeOrderId = bought.acme?.orderId ?? '';
    expect(acmeOrderId).not.toBe('');

    await page.goto(`${ENDPOINTS.dashboard}/orders`);
    await signOutOfDashboard(page);
    await signInToDashboard(page, ENDPOINTS.dashboard, TENANTS.borg.slug);

    await page.goto(`${ENDPOINTS.dashboard}/orders`);
    await expect(page.locator('table tbody tr')).toHaveCount(before.borg + 1);
    await page.getByRole('link', { name: 'Lines' }).first().click();
    await expect(page.locator('table')).toContainText(product.borg);
    await expect(page.locator('table')).not.toContainText(product.acme);
    await shot(page, '10-dashboard-borg-orders');

    await page.goto(`${ENDPOINTS.dashboard}/orders/${acmeOrderId}`);
    await expect(page.getByText('Not found.')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(product.acme);
    await shot(page, '11-dashboard-borg-cannot-see-acme');
  });
});
