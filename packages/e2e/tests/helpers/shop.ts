/**
 * The shopper's journey, in a browser, as a reusable sequence.
 *
 * Two things here are not incidental:
 *
 *   1. **Every click is asserted by its EFFECT, never by the click.** Playwright will happily
 *      click a server-rendered button before React has hydrated, and the click does nothing at all
 *      (lessons/07a). `expect(...).toPass()` around "click, then check the basket count" is what
 *      turns that race into a wait.
 *   2. **The way home from fake-bank is browser Back.** The bank's hosted page has no return link
 *      -- it is a developer's failure-injection console, not a payment provider -- so the
 *      storefront writes the pending order id to localStorage and the checkout page redirects on
 *      `pageshow`. Driving it any other way would test a path no shopper takes.
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

const SHOT_DIR = fileURLToPath(new URL('../../../../test-results/', import.meta.url));

/** Numbered so the directory listing reads in the order the demo happened. */
export async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${SHOT_DIR}${name}.png`, fullPage: true });
}

export interface Shopper {
  readonly phone: string;
  readonly name: string;
}

/** The readable half of the session, as the browser holds it. The token beside it is httpOnly. */
async function sessionPhone(page: Page): Promise<string | null> {
  const found = (await page.context().cookies()).find((c) => c.name === 'mercatus_shopper_phone');
  return found ? decodeURIComponent(found.value) : null;
}

/**
 * Sign in at a storefront. One account for every store that storefront serves (Q20) -- which is
 * why this takes the storefront's origin and no slug at all.
 *
 * The whole attempt is inside `toPass`, reload included. A form that has not hydrated takes the
 * keystrokes and drops the submit, and there is nothing on the page that says so -- so the effect
 * being waited for is the SESSION COOKIE existing, not anything the DOM claims.
 */
export async function signIn(page: Page, storefront: string, shopper: Shopper): Promise<void> {
  await expect(async () => {
    await page.goto(`${storefront}/signin`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Phone').fill(shopper.phone);
    await page.getByLabel('Name').fill(shopper.name);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect.poll(() => sessionPhone(page), { timeout: 5000 }).toBe(shopper.phone);
  }).toPass({ timeout: 60_000 });

  // Signing in navigates away, so come back: the page now says who is signed in, which is the
  // evidence a person would look at rather than a cookie.
  await page.goto(`${storefront}/signin`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator(`[data-signed-in-as="${shopper.phone}"]`)).toBeVisible();
}

/** Who the store shell says is buying, or null when nobody is signed in. */
export async function signedInAs(page: Page): Promise<string | null> {
  const attribute = await page.locator('.sf-nav [data-shopper]').first().getAttribute('data-shopper');
  return attribute === null || attribute === '' ? null : attribute;
}

export async function addToBasket(page: Page, storefront: string, slug: string, title: string): Promise<void> {
  await page.goto(`${storefront}/t/${slug}`, { waitUntil: 'domcontentloaded' });
  const card = page.locator('article.sf-product').filter({ hasText: title });
  await expect(card).toBeVisible();
  await expect(async () => {
    await card.getByRole('button', { name: /Add to basket|Added/ }).click();
    await expect(page.getByRole('link', { name: /Basket \(\d+\)/ })).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000 });
}

export interface Purchase {
  readonly orderId: string;
  readonly number: number;
  /** The banner on the confirmation page: paid | declined | pending | unreachable | unknown. */
  readonly payment: string;
}

/**
 * Check out what is in the basket, settle at the bank, and come back.
 *
 * `behaviour` is fake-bank's own vocabulary (CR1) and is only reached when the bank answered at
 * all. When it did not, the storefront never leaves for the hosted page: the order is placed and
 * unpaid, the response is 202 rather than an error, and the confirmation says so. On a dedicated
 * instance that is the DESIGNED state during an outage of ours (CE2, CG1), so this helper treats
 * it as a completed checkout and reports `payment: 'unreachable'`.
 */
export async function checkout(
  page: Page,
  storefront: string,
  slug: string,
  behaviour: 'approve' | 'decline' = 'approve',
): Promise<Purchase> {
  await page.goto(`${storefront}/t/${slug}/checkout`, { waitUntil: 'domcontentloaded' });

  const pay = page.getByRole('button', { name: /^Pay / });
  await expect(pay).toBeVisible();
  await expect(async () => {
    await pay.click();
    await expect(page).toHaveURL(/\/(pay|order)\//, { timeout: 8000 });
  }).toPass({ timeout: 60_000 });

  if (/\/pay\//.test(page.url())) {
    await shot(page, `bank-${slug}`);
    await page.locator(`button[data-behaviour="${behaviour}"]`).click();
    await expect(page.locator('#result')).toContainText(behaviour === 'approve' ? '"paid"' : '"declined"');
    // Home the way a shopper comes home. The checkout page's `pageshow` handler sees the pending
    // order marker and redirects to the confirmation.
    await page.goBack();
    await expect(page).toHaveURL(/\/order\//, { timeout: 30_000 });
  }

  await expect(page.locator('[data-payment]')).toBeVisible();
  const payment = (await page.locator('[data-payment]').first().getAttribute('data-payment')) ?? '';
  const heading = (await page.getByRole('heading', { level: 1 }).first().textContent()) ?? '';
  const number = Number(/#(\d+)/.exec(heading)?.[1] ?? '0');
  const orderId = /\/order\/([0-9a-f-]+)/.exec(page.url())?.[1] ?? '';

  return { orderId, number, payment };
}

/** Sign in at the merchant dashboard: slug plus role, which is all the stub adapter asks for. */
export async function signInToDashboard(page: Page, dashboard: string, slug: string): Promise<void> {
  await page.goto(`${dashboard}/login`, { waitUntil: 'domcontentloaded' });
  await expect(async () => {
    await page.locator('#slug').fill(slug);
    await page.getByRole('button', { name: /Sign in/ }).click();
    await expect(page.locator('.mc-brand small')).toHaveText(slug, { timeout: 4000 });
  }).toPass({ timeout: 45_000 });
}

/** Sign the merchant out, so the next sign-in starts from a clean session and an empty cache. */
export async function signOutOfDashboard(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('#slug')).toBeVisible();
}
