/**
 * The demo, part three, and the one the whole architecture is for: a store on someone else's
 * server keeps selling while our control plane is down.
 *
 * `zenith` is AppHost B -- its own Postgres, its own process, the same image with
 * `DEPLOYMENT_MODE=dedicated` (CC1). It reaches us over three HTTP URLs and we reach it over none
 * (CE4). It holds a per-instance credential it minted for itself at registration (CE1).
 *
 * The outage is made by killing the Aspire-managed `platform` PROCESS, not by `aspire stop` on
 * AppHost A. Stopping A destroys A's Postgres with it, so the rebuilt control plane has never
 * heard of this installation, the instance token answers 401 and the store stays read_only for
 * ever (lessons/10). Killing the process is the outage that can RECOVER, which is the half of the
 * story worth testing: degrade, keep selling, come back.
 *
 * Skipped, not failed, when AppHost B is not running. B is optional in the everyday loop.
 */
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { addToBasket, checkout, freshShopper, shot, signedInAs, signIn } from './helpers/shop.js';
import type { CapturedProcess } from './helpers/stack.js';
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

/**
 * A shopper minted for this run, and order counts taken relative to what zenith already held.
 *
 * This spec used to refuse to run unless zenith had exactly zero orders, because it asserted
 * order 1 and order 2 -- so the outage demo could be performed exactly once per rebuilt AppHost
 * B. The claim is the arithmetic (two more orders, numbered consecutively, one of them placed
 * while the control plane was dark), not the literals.
 */
const SHOPPER = freshShopper('Zenith Shopper');
const SLUG = TENANTS.zenith.slug;

/**
 * Which box serves zenith this run, read off `.stack/` rather than assumed to be "AppHost B".
 *
 * Since v2.0.0 phase 2 one AppHost B serves any tenant by MERCATUS_TENANT_SLUG, so the three
 * addresses this spec drives belong to an INSTANCE that named itself, not to a fixed half of the
 * address book. Null is zenith not running, which skips -- the same signal as before.
 */
const ZENITH = dedicated(SLUG) ?? { slug: SLUG, store: '', storefront: '', dashboard: '' };

/**
 * The skip reason, when there is one -- and there is one only if this run SAID it was not
 * claiming zenith (`MERCATUS_E2E_DEDICATED`). Otherwise global setup has already refused to start
 * without it, so nothing below may quietly pass by not running.
 */
const notClaimed = expectsDedicated(SLUG) ? '' : notExpectedReason([SLUG]);

let context: BrowserContext | undefined;
let page: Page;
let dedicatedUp = false;
let captured: CapturedProcess | null = null;
let ordersBefore = 0;

test.describe.configure({ mode: 'serial' });

test.describe('the dedicated instance keeps selling with the control plane down', () => {
  test.beforeAll(async ({ browser }) => {
    dedicatedUp =
      ZENITH.store !== '' &&
      (await reachable(ZENITH.store)) &&
      (await reachable(ZENITH.storefront, `/t/${SLUG}`));
    if (!dedicatedUp && notClaimed === '') {
      throw new Error(
        `This run claims ${SLUG}, and global setup found it -- but it stopped answering before ` +
          'the first test. That is a real failure, not a reason to skip.',
      );
    }
    if (dedicatedUp) ordersBefore = await staffOrderCount(ZENITH.store, SLUG);
    context = await browser.newContext();
    page = await context.newPage();
  });

  test.afterAll(async () => {
    // Bring the control plane back whatever happened, so the machine is left the way it was found.
    if (captured !== null && !(await reachable(ENDPOINTS.platform))) {
      relaunch(captured);
      await expect.poll(() => reachable(ENDPOINTS.platform), { timeout: 60_000 }).toBe(true);
    }
    // Optional chaining: a beforeAll that threw leaves this undefined, and the TypeError it
    // raises here buries the failure that actually mattered.
    await context?.close();
  });

  test('the same shopper signs in at the dedicated store', async () => {
    test.skip(!dedicatedUp, notClaimed);

    // A different origin on a different server, so the session is that store's to issue -- which
    // is exactly what lets it verify the shopper offline for the rest of the outage (Q20).
    await signIn(page, ZENITH.storefront, SHOPPER);
    await page.goto(`${ZENITH.storefront}/t/${SLUG}`);
    expect(await signedInAs(page)).toBe(SHOPPER.phone);

    const view = await licenceView(ZENITH.store, SLUG);
    expect(view.status).toBe('active');
    expect(view.state).toBe('healthy');
    await shot(page, '16-zenith-catalog');
  });

  test('buys from the dedicated store, control plane up', async () => {
    test.skip(!dedicatedUp, notClaimed);

    const title = await sellableProduct(ZENITH.store, SLUG);
    await addToBasket(page, ZENITH.storefront, SLUG, title);
    const purchase = await checkout(page, ZENITH.storefront, SLUG);

    expect(purchase.payment).toBe('paid');
    // Zenith's own counter, on its own database (BG2, CC2). On a fresh AppHost B that is 1.
    expect(purchase.number).toBe(ordersBefore + 1);
    await shot(page, '17-zenith-order-paid');
  });

  test('the control plane is stopped', async () => {
    test.skip(!dedicatedUp, notClaimed);

    const pid = pidOnPort(PLATFORM_PORT);
    expect(pid, 'no process is listening on the platform port').not.toBeNull();
    // Everything needed to bring it back, taken BEFORE it dies: argv, cwd and the whole
    // environment -- including the Postgres host port, which Aspire assigned at random.
    captured = captureProcess(pid as number);
    stopProcess(pid as number);

    await expect.poll(() => reachable(ENDPOINTS.platform), { timeout: 30_000 }).toBe(false);

    // The dedicated box notices by POLLING; nothing reaches into it to tell it (CE4).
    await expect
      .poll(async () => (await licenceView(ZENITH.store, SLUG)).state, {
        timeout: 60_000,
      })
      .toBe('grace');

    const view = await licenceView(ZENITH.store, SLUG);
    // Unreachable is OURS and never becomes the merchant's status (CG3).
    expect(view.status).toBe('active');
  });

  test('the dedicated store still completes a checkout', async () => {
    test.skip(!dedicatedUp, notClaimed);
    expect(await reachable(ENDPOINTS.platform)).toBe(false);

    const title = await sellableProduct(ZENITH.store, SLUG);
    await addToBasket(page, ZENITH.storefront, SLUG, title);
    const purchase = await checkout(page, ZENITH.storefront, SLUG);

    // Placed, numbered and priced by their own database, with our control plane dark. `paid` when
    // the bank is still reachable, `unreachable` when it is not -- both are a completed checkout
    // as far as this store is concerned, and neither is an error a shopper can act on (CG1).
    expect(['paid', 'unreachable']).toContain(purchase.payment);
    expect(purchase.number).toBe(ordersBefore + 2);
    await shot(page, '18-zenith-order-during-outage');

    // And the rest of the shop is untouched: browsing, the shopper's own orders, and the
    // merchant's dashboard on their own server.
    expect((await probe(ZENITH.storefront, `/t/${SLUG}`)).status).toBe(200);
    expect((await probe(ZENITH.store, '/health')).status).toBe(200);
    expect((await probe(ZENITH.dashboard, '/')).status).toBe(200);

    await page.goto(`${ZENITH.storefront}/t/${SLUG}/orders`);
    await expect(page.locator('.sf-page-header')).toContainText('2 orders at this store');
    await shot(page, '19-zenith-orders-during-outage');
  });

  test('and catches up when the control plane comes back', async () => {
    test.skip(!dedicatedUp, notClaimed);
    expect(captured, 'the control plane was never captured').not.toBeNull();

    const pid = relaunch(captured as CapturedProcess);
    // Ours, not Aspire's -- so it is started under a supervisor that watches DCP and terminates
    // it when the AppHost stops. Without that, `aspire stop` reports success and leaves a control
    // plane on 4001 answering /health with 200 over a database that no longer exists.
    process.stdout.write(
      `\n  control plane relaunched as pid ${String(pid)}, supervised: it exits with the AppHost ` +
        '(pid also in test-results/relaunched-platform.pid)\n',
    );
    await expect.poll(() => reachable(ENDPOINTS.platform), { timeout: 60_000 }).toBe(true);

    // One poll later, on its own, with nothing restarted on their side.
    await expect
      .poll(async () => (await licenceView(ZENITH.store, SLUG)).state, {
        timeout: 60_000,
      })
      .toBe('healthy');

    await page.goto(`${ZENITH.storefront}/t/${SLUG}`);
    await expect(page.locator('.sf-banner')).toHaveCount(0);
    await shot(page, '20-zenith-recovered');
  });
});
