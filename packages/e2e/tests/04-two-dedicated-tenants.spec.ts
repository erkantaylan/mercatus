/**
 * The demo, part four, and the claim v2.0.0 was built to make: **a second dedicated tenant costs
 * one command and zero edits to AppHost A.**
 *
 * `orion` is not in any seed, any AppHost, or any list of slugs. It was bought through the
 * control plane's own API while the stack was already running --
 *
 *   POST /tenants            {slug: 'orion', name: 'Orion Instruments', tier: 'dedicated'}
 *   POST /tenants/orion/activate
 *   POST /installations      {tenantSlug: 'orion', expectedHost: 'orion.localtest.me'}
 *   aspire/scripts/run-dedicated.sh orion <bootstrapToken>
 *
 * (The dev loop seeds orion's tenant and an unspent, host-pinned installation for it, so
 * `aspire/scripts/run-dedicated.sh orion` alone starts it and a rebuilt control plane does not
 * cost an operator those four calls again. The four calls are still what a THIRD tenant costs,
 * and the full recipe is in `aspire/scripts/run-dedicated.sh`'s header and the README.)
 *
 * -- and everything else followed from the registration handshake: its Aspire-assigned addresses,
 * its own OIDC client, its own organization at the issuer (created by the control plane, because
 * a tenant bought after AppHost A started has none), its licence and its per-instance token.
 *
 * So this file asserts the whole topology at once, with FOUR merchants serving:
 *
 *   1. two pooled tenants in one process and one database (acme, borg)
 *   2. two dedicated tenants, each its own AppHost, process, Postgres and port (zenith, orion)
 *   3. one shopper account buying at all four
 *   4. four merchants who can each see only their own orders
 *   5. the control plane stopped -- and BOTH dedicated stores still completing a checkout
 *
 * THIS FILE CAN FAIL. Every test in it used to begin `test.skip(!bothUp, ...)`, so the everyday
 * loop -- one AppHost B, zenith only -- reported the whole file green having proved none of the
 * five claims above. A headline check that cannot fail is the hole BL1 names, one level up. Now
 * the run DECLARES which dedicated instances it is claiming (`MERCATUS_E2E_DEDICATED`, default
 * `zenith,orion`): a claimed instance that is not answering fails global setup, and the only way
 * to reach a skip here is to have said so on the command line, which the skip reason quotes back.
 *
 * ONE browser context for the file, because "one shopper account" is the claim and a fresh
 * context per test would be a fresh cookie jar and a different person.
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
import type { CapturedProcess, DedicatedEndpoints } from './helpers/stack.js';
import {
  ENDPOINTS,
  PLATFORM_PORT,
  TENANTS,
  captureProcess,
  dedicated,
  expectsDedicated,
  licenceView,
  notExpectedReason,
  pidOnPort,
  probe,
  reachable,
  relaunch,
  sellableProduct,
  staffOrderCount,
  stopProcess,
} from './helpers/stack.js';

/** One person, minted for this run, who will hold an account at four shops on three origins. */
const SHOPPER = freshShopper('Four Shops');

/** The tenant this phase adds. Nothing in the repo names it except this file and the diary. */
const ORION = 'orion';

const NOWHERE: DedicatedEndpoints = { slug: '', store: '', storefront: '', dashboard: '' };
const BOXES: readonly DedicatedEndpoints[] = [
  dedicated(TENANTS.zenith.slug) ?? { ...NOWHERE, slug: TENANTS.zenith.slug },
  dedicated(ORION) ?? { ...NOWHERE, slug: ORION },
];

interface Placed {
  readonly orderId: string;
  readonly number: number;
}

const bought: Record<string, Placed> = {};
/** What each store already held. Every count below is relative to these, so a re-run passes. */
const before: Record<string, number> = {};

let context: BrowserContext | undefined;
let page: Page;
/** Did this run promise both boxes? Set once, in beforeAll, from what was actually reachable. */
let bothUp = false;
/** The skip reason when this run deliberately did not claim them. Empty when it did. */
const notClaimed =
  expectsDedicated(TENANTS.zenith.slug) && expectsDedicated(ORION)
    ? ''
    : notExpectedReason([TENANTS.zenith.slug, ORION]);
let captured: CapturedProcess | null = null;

test.describe.configure({ mode: 'serial' });

test.describe('two pooled and TWO dedicated tenants, at once', () => {
  test.beforeAll(async ({ browser }) => {
    const reachableBoxes = await Promise.all(
      BOXES.map(async (box) =>
        box.store !== '' &&
        (await reachable(box.store)) &&
        (await reachable(box.storefront, `/t/${box.slug}`)),
      ),
    );
    bothUp = reachableBoxes.every(Boolean);
    // Global setup already refused to start when a CLAIMED instance was missing, so reaching here
    // with one down means this run did not claim it. Anything else is a bug worth failing on.
    if (!bothUp && notClaimed === '') {
      throw new Error(
        'This run claims zenith and orion, and global setup found both -- but one of them stopped ' +
          'answering before the first test. That is a real failure, not a reason to skip.',
      );
    }

    before[TENANTS.acme.slug] = await staffOrderCount(ENDPOINTS.storePooled, TENANTS.acme.slug);
    before[TENANTS.borg.slug] = await staffOrderCount(ENDPOINTS.storePooled, TENANTS.borg.slug);
    if (bothUp) {
      for (const box of BOXES) before[box.slug] = await staffOrderCount(box.store, box.slug);
    }

    context = await browser.newContext();
    page = await context.newPage();
  });

  test.afterAll(async () => {
    // Leave the machine as it was found, whatever failed: a control plane this file stopped and
    // did not bring back would break every later run of the suite.
    if (captured !== null && !(await reachable(ENDPOINTS.platform))) {
      relaunch(captured);
      await expect.poll(() => reachable(ENDPOINTS.platform), { timeout: 60_000 }).toBe(true);
    }
    await context?.close();
  });

  test('four merchants are serving: two pooled, two dedicated', async () => {
    test.skip(!bothUp, notClaimed);

    // The pooled pair: one store process, one database, two shops.
    expect((await probe(ENDPOINTS.storefront, `/t/${TENANTS.acme.slug}`)).status).toBe(200);
    expect((await probe(ENDPOINTS.storefront, `/t/${TENANTS.borg.slug}`)).status).toBe(200);

    // The dedicated pair: two of everything, and nothing in common but the control plane.
    const [zenith, orion] = BOXES as readonly [DedicatedEndpoints, DedicatedEndpoints];
    expect(new Set([zenith.store, orion.store, ENDPOINTS.storePooled]).size).toBe(3);
    expect(new Set([zenith.storefront, orion.storefront, ENDPOINTS.storefront]).size).toBe(3);

    for (const box of BOXES) {
      expect((await probe(box.store, '/health')).status).toBe(200);
      expect((await probe(box.storefront, `/t/${box.slug}`)).status).toBe(200);
      expect((await probe(box.dashboard, '/')).status).toBe(200);

      // Each box holds ITS tenant and no other: the slug it was started with is the one its own
      // database answers for, and the other dedicated tenant is not in it (CC2, N=1).
      const own = await probe(box.store, `/t/${box.slug}/branding`);
      expect(own.status, `${box.slug} should serve its own tenant`).toBe(200);
      const other = BOXES.find((b) => b.slug !== box.slug);
      const foreign = await probe(box.store, `/t/${other?.slug ?? 'nobody'}/branding`);
      expect(foreign.status, `${box.slug} must not know ${String(other?.slug)}`).not.toBe(200);

      const view = await licenceView(box.store, box.slug);
      expect(view.status).toBe('active');
      expect(view.state).toBe('healthy');
    }
  });

  test('one shopper account buys from all four', async () => {
    test.skip(!bothUp, notClaimed);

    // -- the pooled storefront: one sign-in, two shops --------------------------------------
    await signIn(page, ENDPOINTS.storefront, SHOPPER);
    for (const slug of [TENANTS.acme.slug, TENANTS.borg.slug]) {
      await page.goto(`${ENDPOINTS.storefront}/t/${slug}`);
      expect(await signedInAs(page)).toBe(SHOPPER.phone);
    }

    for (const slug of [TENANTS.acme.slug, TENANTS.borg.slug]) {
      const title = await sellableProduct(ENDPOINTS.storePooled, slug);
      await addToBasket(page, ENDPOINTS.storefront, slug, title);
      const purchase = await checkout(page, ENDPOINTS.storefront, slug);
      expect(purchase.payment).toBe('paid');
      // Per-tenant, gapless numbering from that tenant's own counter, never a global one (BG2).
      expect(purchase.number).toBe((before[slug] ?? 0) + 1);
      bought[slug] = purchase;
    }

    // -- and each dedicated box, on its own origin, with the SAME account --------------------
    //
    // A dedicated store issues its own session cookie for its own origin (Q20). That is not a
    // weaker sign-in, it is the one that keeps working while we are dark -- which is what the
    // last test in this file demonstrates.
    for (const box of BOXES) {
      await signIn(page, box.storefront, SHOPPER);
      await page.goto(`${box.storefront}/t/${box.slug}`);
      expect(await signedInAs(page), `${box.slug} should recognise the shopper`).toBe(SHOPPER.phone);

      const title = await sellableProduct(box.store, box.slug);
      await addToBasket(page, box.storefront, box.slug, title);
      const purchase = await checkout(page, box.storefront, box.slug);
      expect(purchase.payment).toBe('paid');
      // Its own counter, in its own database, on its own server (BG2, CC2).
      expect(purchase.number).toBe((before[box.slug] ?? 0) + 1);
      bought[box.slug] = purchase;
      await shot(page, `21-${box.slug}-order-paid`);
    }

    // Four orders, four different rows, in three different databases.
    const ids = new Set(Object.values(bought).map((p) => p.orderId));
    expect(ids.size).toBe(4);
  });

  test('each merchant sees only its own orders', async () => {
    test.skip(!bothUp, notClaimed);

    // -- the pooled pair: same process, same database, separated by RLS (BE1) ----------------
    await signInToDashboard(page, ENDPOINTS.dashboard, TENANTS.acme.slug);
    await page.goto(`${ENDPOINTS.dashboard}/orders`);
    await expect(page.locator('table tbody tr')).toHaveCount((before[TENANTS.acme.slug] ?? 0) + 1);
    await page.goto(`${ENDPOINTS.dashboard}/orders/${bought[TENANTS.borg.slug]?.orderId ?? ''}`);
    await expect(page.getByText('Not found.')).toBeVisible();

    await page.goto(`${ENDPOINTS.dashboard}/orders`);
    await signOutOfDashboard(page);
    await signInToDashboard(page, ENDPOINTS.dashboard, TENANTS.borg.slug);
    await page.goto(`${ENDPOINTS.dashboard}/orders`);
    await expect(page.locator('table tbody tr')).toHaveCount((before[TENANTS.borg.slug] ?? 0) + 1);
    await page.goto(`${ENDPOINTS.dashboard}/orders/${bought[TENANTS.acme.slug]?.orderId ?? ''}`);
    await expect(page.getByText('Not found.')).toBeVisible();

    // -- the dedicated pair: separated by being two machines ---------------------------------
    //
    // The interesting assertion is not that they cannot see each other -- they share nothing --
    // it is that each merchant's dashboard is on THEIR box and answers about THEIR database, so
    // the other dedicated tenant's order id is a row that does not exist here at all.
    for (const box of BOXES) {
      const other = BOXES.find((b) => b.slug !== box.slug);
      await signInToDashboard(page, box.dashboard, box.slug);
      await page.goto(`${box.dashboard}/orders`);
      await expect(page.locator('table tbody tr')).toHaveCount((before[box.slug] ?? 0) + 1);
      await expect(page.locator('table tbody tr').first().locator('[data-payment="paid"]')).toBeVisible();
      await shot(page, `22-dashboard-${box.slug}-orders`);

      await page.goto(`${box.dashboard}/orders/${bought[other?.slug ?? '']?.orderId ?? 'none'}`);
      await expect(page.getByText('Not found.')).toBeVisible();

      // ...and the pooled merchants' orders are not there either.
      await page.goto(`${box.dashboard}/orders/${bought[TENANTS.acme.slug]?.orderId ?? 'none'}`);
      await expect(page.getByText('Not found.')).toBeVisible();
    }

    // The shopper's own view is the other half of the same rule (BI2): one account, and one
    // order at each of the four shops.
    await page.goto(`${ENDPOINTS.storefront}/t/${TENANTS.acme.slug}/orders`);
    await expect(page.locator('.sf-page-header')).toContainText('1 orders at this store');
    await page.goto(`${ENDPOINTS.storefront}/t/${TENANTS.borg.slug}/orders`);
    await expect(page.locator('.sf-page-header')).toContainText('1 orders at this store');
    for (const box of BOXES) {
      await page.goto(`${box.storefront}/t/${box.slug}/orders`);
      await expect(page.locator('.sf-page-header')).toContainText('1 orders at this store');
    }
  });

  test('the control plane is stopped, and both dedicated boxes notice by themselves', async () => {
    test.skip(!bothUp, notClaimed);

    const pid = pidOnPort(PLATFORM_PORT);
    expect(pid, 'no process is listening on the platform port').not.toBeNull();
    captured = captureProcess(pid as number);
    stopProcess(pid as number);

    await expect.poll(() => reachable(ENDPOINTS.platform), { timeout: 30_000 }).toBe(false);

    // Nothing reaches into either box to tell it (CE4): each one finds out when its own poll
    // fails, and each one degrades on its own clock.
    for (const box of BOXES) {
      await expect
        .poll(async () => (await licenceView(box.store, box.slug)).state, { timeout: 60_000 })
        .toBe('grace');
      // Unreachable is OURS and never becomes the merchant's status (CG3).
      expect((await licenceView(box.store, box.slug)).status).toBe('active');
    }
  });

  test('BOTH dedicated stores still complete a checkout with the control plane down', async () => {
    test.skip(!bothUp, notClaimed);
    expect(await reachable(ENDPOINTS.platform)).toBe(false);

    for (const box of BOXES) {
      // Still signed in, on a session that box issued for its own origin -- no round trip to us.
      await page.goto(`${box.storefront}/t/${box.slug}`);
      expect(await signedInAs(page), `${box.slug} should still know the shopper`).toBe(SHOPPER.phone);

      const title = await sellableProduct(box.store, box.slug);
      await addToBasket(page, box.storefront, box.slug, title);
      const purchase = await checkout(page, box.storefront, box.slug);

      // Placed, numbered and priced by their own database with our control plane dark. `paid`
      // while the bank answers, `unreachable` when it does not: both are a completed checkout as
      // far as this store is concerned, and neither is an error a shopper can act on (CG1).
      expect(['paid', 'unreachable']).toContain(purchase.payment);
      expect(purchase.number).toBe((before[box.slug] ?? 0) + 2);
      await shot(page, `23-${box.slug}-order-during-outage`);

      await page.goto(`${box.storefront}/t/${box.slug}/orders`);
      await expect(page.locator('.sf-page-header')).toContainText('2 orders at this store');
      expect((await probe(box.dashboard, '/')).status).toBe(200);
    }
  });

  test('and both catch up when the control plane comes back', async () => {
    test.skip(!bothUp, notClaimed);
    expect(captured, 'the control plane was never captured').not.toBeNull();

    relaunch(captured as CapturedProcess);
    await expect.poll(() => reachable(ENDPOINTS.platform), { timeout: 60_000 }).toBe(true);

    for (const box of BOXES) {
      await expect
        .poll(async () => (await licenceView(box.store, box.slug)).state, { timeout: 60_000 })
        .toBe('healthy');
    }
    captured = null;
  });
});
