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

/**
 * The dev passwords the identity bootstrap seeds (`IDENTITY_DEV_PASSWORD`, default below). They
 * are only ever used when the stack is on `AUTH_ADAPTER=oidc`; the stub's sign-in page asks for
 * no password at all, which is exactly what it is for.
 */
const SHOPPER_PASSWORD = process.env['MERCATUS_E2E_PASSWORD'] ?? 'Mercatus-dev-1';
const STAFF_PASSWORD = SHOPPER_PASSWORD;

/**
 * A shopper who has never shopped here before, minted per run.
 *
 * "This shopper has 1 order at this store" is an assertion about a PERSON, not about the
 * database, so it holds on the tenth run as well as the first -- which is the whole difference
 * between a suite you can re-run and one that needs the stack destroyed and rebuilt first. The
 * phone is the identity the storefront signs in with, so a fresh one is a fresh shopper row.
 */
export function freshShopper(label: string): Shopper {
  const digits = String(Math.floor(Math.random() * 9_000_000) + 1_000_000);
  return { phone: `+9055${digits}`, name: `E2E ${label}` };
}

/**
 * The readable half of the session AT ONE STOREFRONT, as the browser holds it. The token beside
 * it is httpOnly.
 *
 * The URL is not decoration. `context.cookies()` with no argument returns every cookie in the
 * jar, whatever host set it -- and every storefront names the same person in
 * `mercatus_shopper_phone`, so "is our shopper signed in here?" was answered `yes` by a cookie
 * another store had set. The sign-in below then returned without this store ever minting a token,
 * and the first thing that actually needed one failed with `UNAUTHENTICATED` on a page that still
 * said who was buying. Scoped to the origin, the question is the one being asked.
 */
async function sessionPhone(page: Page, storefront: string): Promise<string | null> {
  const found = (await page.context().cookies(storefront)).find(
    (c) => c.name === 'mercatus_shopper_phone',
  );
  return found ? decodeURIComponent(found.value) : null;
}

/**
 * The issuer's sign-in page, whichever one this stack is running (v2.0.0 repair round 1).
 *
 * The browser leaves the storefront for the STORE's `/auth/login`, which 302s on to whatever
 * `AUTH_ADAPTER` names: the store's own `/dev/login` page under `stub`, Logto under `oidc`. That
 * is the whole point of the repair -- one path, both adapters -- so the helper handles both and
 * the suite is adapter-agnostic too.
 *
 * The stub's page is server-rendered HTML with no script, so there is nothing to hydrate and
 * nothing to race; Logto's is a React app, which is why the fill and the submit are wrapped the
 * way every other form in this suite is (lessons/07a, /11).
 */
async function signInAtIssuer(page: Page, identity: string, secret: string): Promise<void> {
  const stub = page.locator('form[data-dev-login]');
  if ((await stub.count()) > 0) {
    await page.locator('#subject').fill(identity);
    await page.getByRole('button', { name: 'Sign in' }).click();
    return;
  }
  // Logto's hosted experience. Username + password, then whatever consent it asks for the first
  // time a user meets a client (consent is per user+application and is remembered; lessons/14).
  await page.getByLabel(/username|email|phone/i).first().fill(identity);
  await page.locator('input[type="password"]').first().fill(secret);
  await page.getByRole('button', { name: /sign in|continue/i }).first().click();
  const consent = page.getByRole('button', { name: /authorize|agree|continue/i });
  if (await consent.first().isVisible({ timeout: 3000 }).catch(() => false)) {
    await consent.first().click();
  }
}

/**
 * Sign in at a storefront. One account for every store that storefront serves (Q20) -- which is
 * why this takes the storefront's origin and no slug at all.
 *
 * It is a REAL ROUND TRIP now: storefront -> store `/auth/login` -> issuer -> storefront
 * `/api/auth/callback`. Before v2.0.0's repair the storefront posted a phone number at
 * `/dev/login/shopper`, a route that only exists while `AUTH_ADAPTER=stub` -- so this helper
 * could only ever drive the stub, and switching the real issuer on broke sign-in outright.
 *
 * The whole attempt is inside `toPass`, navigation included. A form that has not hydrated takes
 * the keystrokes and drops the submit, and there is nothing on the page that says so -- so the
 * effect being waited for is the SESSION COOKIE existing, not anything the DOM claims.
 */
export async function signIn(page: Page, storefront: string, shopper: Shopper): Promise<void> {
  // This host's jar first. The condition below is "the phone cookie says our shopper", and a
  // cookie is scoped by HOST and not by origin -- so a sign-in at another storefront on the same
  // hostname satisfies it without this one ever having minted a token, and the checkout that
  // follows answers UNAUTHENTICATED with the page still naming the shopper. Clearing only this
  // host leaves every other storefront's session alone, which is the point of the exercise.
  await page.context().clearCookies({ domain: new URL(storefront).hostname });
  await expect(async () => {
    await page.goto(`${storefront}/signin`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-signin-start]').click();
    await signInAtIssuer(page, shopper.phone, SHOPPER_PASSWORD);
    await expect.poll(() => sessionPhone(page, storefront), { timeout: 8000 }).toBe(shopper.phone);
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

/**
 * Sign in at the merchant dashboard.
 *
 * The slug is not a credential -- it selects the ORGANIZATION the login is for, so the issuer can
 * mint a token scoped to one tenant and no other (BC1, CD3). Everything after the button is the
 * same round trip the shopper takes, ending at the dashboard's own registered `/callback`.
 */
export async function signInToDashboard(page: Page, dashboard: string, slug: string): Promise<void> {
  await expect(async () => {
    await page.goto(`${dashboard}/login`, { waitUntil: 'domcontentloaded' });
    await page.locator('#slug').fill(slug);
    await page.getByRole('button', { name: /Sign in/ }).click();
    await signInAtIssuer(page, `${slug}_owner`, STAFF_PASSWORD);
    await expect(page.locator('.mc-brand small')).toHaveText(slug, { timeout: 8000 });
  }).toPass({ timeout: 60_000 });
}

/** Sign the merchant out, so the next sign-in starts from a clean session and an empty cache. */
export async function signOutOfDashboard(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('#slug')).toBeVisible();
}
