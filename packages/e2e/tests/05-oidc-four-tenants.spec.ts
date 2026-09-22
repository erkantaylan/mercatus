/**
 * THE CLAIM REPAIR ROUND 1 EXISTS FOR: two pooled tenants, two dedicated tenants, **real OIDC on
 * both planes**, and one shopper account across all of them -- in a browser, with shopping and
 * with dashboards.
 *
 * Before this, those two halves were mutually exclusive. The storefront minted shopper tokens at
 * `${store}/dev/login/shopper` and the dashboard staff tokens at `/dev/login/staff`; both routes
 * are registered only while `AUTH_ADAPTER=stub`, so `MERCATUS_AUTH_ADAPTER=oidc` answered 502 on
 * shopper sign-in and 404 on merchant sign-in, on BOTH planes. You could have the four-tenant
 * shopping demo on the stub, or real OIDC through a shell script with no shopping and no
 * dashboards. Never both. This file is the proof that it is now one topology.
 *
 * What it drives, in one browser context, as one person:
 *
 *   1. sign in ONCE at the issuer, at the pooled storefront
 *   2. buy at `acme`, then at `borg` -- same origin, no second sign-in
 *   3. go to zenith's own box on its own hostname: the issuer recognises the session, asks for no
 *      password, and that store issues a session of ITS OWN (Q20). Buy.
 *   4. the same at orion's box
 *   5. the subject is the SAME string at all three origins, and the three session tokens are not
 *      interchangeable -- one account, three sessions, which is the whole of Q20
 *   6. four merchants sign in at four dashboards through the same issuer, each seeing exactly one
 *      more order than before and none of anybody else's (BI1)
 *
 * IT SKIPS ONLY WHEN THE STACK IS ON THE STUB, and it says which command turns that around. The
 * adapter is DETECTED, not declared: `/auth/login` answers a 302, and where it points is which
 * issuer this store is talking to. `MERCATUS_E2E_REQUIRE_OIDC=1` turns the skip into a failure,
 * which is what the acceptance run should use.
 */
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import {
  addToBasket,
  checkout,
  dashboardToken,
  DEV_PASSWORD,
  issuerShopper,
  shot,
  signedInAs,
  signIn,
  signInToDashboard,
  signOutOfDashboard,
  signOutOfIssuer,
} from './helpers/shop.js';
import type { DedicatedEndpoints } from './helpers/stack.js';
import { ENDPOINTS, TENANTS, dedicated, orderCountWithToken, sellableProduct } from './helpers/stack.js';

/**
 * The seeded issuer account (`packages/identity/src/bootstrap.ts`), and a fresh phone for the
 * orders. Under a real issuer the subject says nothing about a phone, so the checkout form asks
 * for one -- which is the honest arrangement either way: a phone is contact detail on an order,
 * and the subject is who the person is (BI2).
 */
const SHOPPER = issuerShopper(
  'OIDC Four Shops',
  process.env['MERCATUS_E2E_SHOPPER'] ?? 'shopper',
  DEV_PASSWORD,
);

const NOWHERE: DedicatedEndpoints = { slug: '', store: '', storefront: '', dashboard: '' };
const BOXES: readonly DedicatedEndpoints[] = [
  dedicated(TENANTS.zenith.slug) ?? { ...NOWHERE, slug: TENANTS.zenith.slug },
  dedicated('orion') ?? { ...NOWHERE, slug: 'orion' },
];

/** Every merchant in the topology, and where their dashboard is. */
const MERCHANTS: readonly { slug: string; store: string; dashboard: string }[] = [
  { slug: TENANTS.acme.slug, store: ENDPOINTS.storePooled, dashboard: ENDPOINTS.dashboard },
  { slug: TENANTS.borg.slug, store: ENDPOINTS.storePooled, dashboard: ENDPOINTS.dashboard },
  ...BOXES.map((box) => ({ slug: box.slug, store: box.store, dashboard: box.dashboard })),
];

const REQUIRED = process.env['MERCATUS_E2E_REQUIRE_OIDC'] === '1';

/**
 * Which issuer this store is really talking to, asked of the store rather than of an environment
 * variable this process happens to hold.
 *
 * `/auth/login` is a 302 under both adapters. The stub's points at the store's own `/dev/login`
 * page; Logto's points at `/oidc/auth` on the issuer. Nothing else has to be true for this to be
 * a reliable answer, and it stays reliable if the adapter is switched without restarting this
 * suite's shell.
 */
async function adapterOf(storeApi: string): Promise<'stub' | 'oidc' | 'unknown'> {
  const response = await fetch(
    `${storeApi}/auth/login?audience=shopper&via=store&next=%2F`,
    { redirect: 'manual', signal: AbortSignal.timeout(8000) },
  ).catch(() => null);
  const location = response?.headers.get('location') ?? '';
  if (location.includes('/dev/login')) return 'stub';
  if (location.includes('/oidc/auth')) return 'oidc';
  return 'unknown';
}

let context: BrowserContext | undefined;
let page: Page;
let ready = false;
let skipReason = '';
/** The subject the issuer gave this person, as each store's own session records it. */
const subjects: Record<string, string> = {};
const bought: Record<string, { orderId: string; number: number }> = {};
const before: Record<string, number> = {};
/**
 * The token each merchant's BROWSER was handed by the issuer. There is no `/dev/login/staff`
 * under `oidc`, and that is the point -- the suite asks the store API its questions with the
 * credential the real round trip produced.
 */
const staffTokens: Record<string, string> = {};

test.describe.configure({ mode: 'serial' });

test.describe('real OIDC, four tenants, one shopper account, in a browser', () => {
  test.beforeAll(async ({ browser }) => {
    const missing = [ENDPOINTS.storePooled, ...BOXES.map((b) => b.store)].filter((u) => u === '');
    if (missing.length > 0) {
      skipReason = 'this file needs the pooled plane and BOTH dedicated instances running';
    } else {
      const adapters = await Promise.all(
        [ENDPOINTS.storePooled, ...BOXES.map((b) => b.store)].map(adapterOf),
      );
      const onOidc = adapters.every((adapter) => adapter === 'oidc');
      if (!onOidc) {
        skipReason =
          `the stack is on the stub adapter (${adapters.join(', ')}). Restart it with ` +
          'MERCATUS_AUTH_ADAPTER=oidc exported to BOTH AppHosts:\n' +
          '  MERCATUS_AUTH_ADAPTER=oidc (cd aspire/AppHostA && aspire run --detach ...)\n' +
          '  MERCATUS_AUTH_ADAPTER=oidc aspire/scripts/run-dedicated.sh zenith\n' +
          '  MERCATUS_AUTH_ADAPTER=oidc aspire/scripts/run-dedicated.sh orion';
      }
      ready = onOidc;
    }

    if (!ready && REQUIRED) {
      // The acceptance run says MERCATUS_E2E_REQUIRE_OIDC=1, and then a skip is a failure. A
      // headline claim that can only ever skip is the hole this round was opened to close.
      throw new Error(`MERCATUS_E2E_REQUIRE_OIDC=1 but ${skipReason}`);
    }

    context = await browser.newContext();
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('four merchants sign in at the real issuer, at four dashboards', async () => {
    test.skip(!ready, skipReason);

    for (const merchant of MERCHANTS) {
      // FOUR DIFFERENT PEOPLE, so the issuer's session is ended between them. Leaving it would
      // sign the next merchant in silently as the previous one -- which is the same SSO the
      // shopper relies on two tests below, and exactly wrong here. It is also why a real merchant
      // signing out of their dashboard does NOT sign out of the issuer: those are two sessions.
      await signOutOfIssuer(page, ENDPOINTS.logto);

      // `<slug>_owner` at the issuer -- a real user with the `owner` role in that tenant's
      // organization. orion's was created by the CONTROL PLANE at registration time, because a
      // tenant bought after AppHost A started is in no list AppHost A holds.
      await signInToDashboard(page, merchant.dashboard, merchant.slug);
      await expect(page.locator('.mc-brand small')).toHaveText(merchant.slug);
      staffTokens[merchant.slug] = await dashboardToken(page);
      before[merchant.slug] = await orderCountWithToken(
        merchant.store,
        staffTokens[merchant.slug] ?? '',
      );
      await shot(page, `oidc-01-dashboard-${merchant.slug}`);
      await signOutOfDashboard(page);
    }

    // acme and borg share one dashboard origin and one store process, and still got two
    // different tokens naming two different tenants (BC1): switching stores mints a new token,
    // never a wider one.
    expect(new Set(Object.values(staffTokens)).size).toBe(MERCHANTS.length);
  });

  test('the shopper signs in ONCE, at the real issuer', async () => {
    test.skip(!ready, skipReason);

    // A merchant was the last person at the issuer. The shopper is somebody else.
    await signOutOfIssuer(page, ENDPOINTS.logto);
    subjects['pooled'] = await signIn(page, ENDPOINTS.storefront, SHOPPER);
    // A Logto user id, not a phone: the subject is opaque and says nothing about the person.
    expect(subjects['pooled']).not.toBe('');
    expect(subjects['pooled']).not.toContain('dev-shopper');
    await shot(page, 'oidc-02-signed-in');
  });

  test('buys at both pooled shops without signing in again', async () => {
    test.skip(!ready, skipReason);

    for (const slug of [TENANTS.acme.slug, TENANTS.borg.slug]) {
      await addToBasket(
        page,
        ENDPOINTS.storefront,
        slug,
        await sellableProduct(ENDPOINTS.storePooled, slug),
      );
      const purchase = await checkout(page, ENDPOINTS.storefront, slug, SHOPPER);
      expect(purchase.payment).toBe('paid');
      bought[slug] = { orderId: purchase.orderId, number: purchase.number };
    }
    await shot(page, 'oidc-03-pooled-bought');
  });

  test('is recognised at BOTH dedicated boxes -- same account, each box its own session', async () => {
    test.skip(!ready, skipReason);

    for (const box of BOXES) {
      // A different origin on a different server. The issuer already knows this person, so there
      // is no second password; the store still issues a session of its OWN, which is what lets it
      // keep serving them while the control plane is dark (Q20, CG1).
      subjects[box.slug] = await signIn(page, box.storefront, SHOPPER);
      await page.goto(`${box.storefront}/t/${box.slug}`, { waitUntil: 'domcontentloaded' });
      expect(await signedInAs(page)).toBe(subjects[box.slug]);
    }

    // ONE ACCOUNT. The three stores are three processes, three databases and three session keys,
    // and they all name the same person -- which is the claim, stated as an equality.
    expect(new Set(Object.values(subjects)).size).toBe(1);
    await shot(page, 'oidc-04-same-subject-everywhere');
  });

  test('buys at both dedicated shops', async () => {
    test.skip(!ready, skipReason);

    for (const box of BOXES) {
      await addToBasket(
        page,
        box.storefront,
        box.slug,
        await sellableProduct(box.store, box.slug),
      );
      const purchase = await checkout(page, box.storefront, box.slug, SHOPPER);
      expect(purchase.payment).toBe('paid');
      bought[box.slug] = { orderId: purchase.orderId, number: purchase.number };
    }
    await shot(page, 'oidc-05-dedicated-bought');
  });

  test('each of the four merchants sees exactly ONE more order, and only its own', async () => {
    test.skip(!ready, skipReason);

    for (const merchant of MERCHANTS) {
      const token = staffTokens[merchant.slug] ?? '';
      const after = await orderCountWithToken(merchant.store, token);
      expect(after, `${merchant.slug} should hold exactly one more order`).toBe(
        (before[merchant.slug] ?? 0) + 1,
      );
    }

    // BI1, stated as a refusal rather than as a count: acme's token, presented to acme's OWN
    // store, cannot reach borg's order -- they share a process and a database, and the tenant
    // comes from the token, never from the request.
    //
    // By order ID, not by number. Order numbers are per-tenant and gapless (BG2), so acme's
    // fourth order and borg's fourth order are both `#4` and "not in the list" would be a
    // coin flip. The id is a uuid and is the only globally unique thing here.
    const borgOrder = bought[TENANTS.borg.slug];
    const acmeOrder = bought[TENANTS.acme.slug];
    expect(borgOrder).toBeDefined();
    expect(acmeOrder).toBeDefined();

    const response = await fetch(`${ENDPOINTS.storePooled}/api/orders?limit=100`, {
      headers: { authorization: `Bearer ${staffTokens[TENANTS.acme.slug] ?? ''}` },
    });
    const listed = (await response.json()) as { items: { id: string }[] };
    const ids = listed.items.map((order) => order.id);
    expect(ids).toContain(acmeOrder?.orderId);
    expect(ids).not.toContain(borgOrder?.orderId);

    // And by id, directly: borg's order is a 404 to acme, not a 403 that confirms it exists.
    const reached = await fetch(`${ENDPOINTS.storePooled}/api/orders/${borgOrder?.orderId ?? ''}`, {
      headers: { authorization: `Bearer ${staffTokens[TENANTS.acme.slug] ?? ''}` },
    });
    expect(reached.status).toBe(404);
  });
});
