# 07a — apps/storefront (Next.js App Router, 3001)

## What exists now

`apps/storefront`, a Next.js 16 App Router app on **3001**, and the first real content in
`packages/ui`.

`packages/ui`

- `src/tokens.css` — the `--mc-*` set from BUILD-PLAN §7.1, on `:root`.
- `src/reset.css` — six rules.
- `src/index.ts` — still exports nothing, and now says why: **the package is stylesheets only.**
  Three front ends consume it (one Next SSR app, two Vite SPAs); a package that exports React
  components has to agree with all three on a React version and a bundler, and a stylesheet does
  not. Components live in the app that renders them. `package.json` gained
  `"./tokens.css"` and `"./reset.css"` export entries. **Nothing else in `packages/ui` was
  touched** — the two other frontend agents were building concurrently.

`apps/storefront`

```
app/layout.tsx                      imports tokens.css + reset.css + globals.css
app/globals.css                     every value is a var(--mc-*)
app/page.tsx                        TENANT_SLUG set -> redirect to that store; else a store index
app/not-found.tsx
app/t/[slug]/layout.tsx             branding -> CSS custom properties on ONE wrapper (DW)
app/t/[slug]/page.tsx               catalog
app/t/[slug]/p/[id]/page.tsx        product detail
app/t/[slug]/basket/page.tsx        server fetches the catalog, client intersects localStorage
app/t/[slug]/checkout/page.tsx      phone + name -> POST /api/checkout
app/t/[slug]/order/[id]/page.tsx    confirmation, with the payment banner
app/t/[slug]/orders/page.tsx        this shopper's orders
app/api/checkout/route.ts           session + store checkout + fake-bank payment
app/api/payments/callback/route.ts  fake-bank's signed callback, verified
app/api/payments/[orderId]/route.ts what the confirmation polls
components/{AddToBasket,BasketLink,BasketView,CheckoutForm,OrderSettled,ProductCard}.tsx
lib/{api,basket,config,money,payments,session}.ts
```

## The purchase flow, as built

1. `CheckoutForm` POSTs to **this app's** `/api/checkout` — never to the store API. The shopper's
   bearer token and the bank's HMAC secret both stay server-side.
2. The route handler mints a shopper token (`POST /dev/login/shopper`, stub adapter), places the
   order (`POST /t/:slug/checkout`), then asks fake-bank for a signed payment.
3. The browser navigates to fake-bank's hosted page. The order id is written to
   `localStorage['mercatus.pendingOrder.<slug>']` first.
4. fake-bank posts its signed callback to `/api/payments/callback`, which **verifies the HMAC
   before believing it** and records the outcome in a per-process Map.
5. Browser **Back** lands on the checkout page, which sees the pending marker and replaces itself
   with `/t/<slug>/order/<id>`. That page clears the basket and the marker and polls
   `/api/payments/<orderId>` until the bank has answered.

fake-bank's page has no "return to merchant" link — it is a failure-injection console, not a
provider — so Back is the return path. The checkout page listens for `pageshow`, not just mount,
so a bfcache restore still redirects.

## Gate — executed, in Chrome, against a live stack

Headless Chrome via Playwright, against `next dev` on 3001, the store API on 4002 and fake-bank on
4004. Script and screenshots:
`/tmp/claude-1000/-home-kappa-Desktop-projects-alternet/2215845f-a99d-46b0-95ee-f6b981bb1b66/scratchpad/pw/gate.mjs`
and `.../scratchpad/shots-07a/*.png` (10 shots).

```
[gate] store header: Acme Supply
[gate] accent: #2f6f4f
[gate] catalog: Anvil, 50kg | Giant Rubber Band | Portable Hole | Rocket Skates
[gate] basket in localStorage: [{"productId":"ea79069b-...","qty":1}]
[gate] checkout button: Pay 2499.00 TRY
[gate] landed on the bank: http://127.0.0.1:4004/pay/4e04053a-1661-4c03-bb3b-8c98aabe5ade
[gate] bank answered: 200 { "id": "4e04053a-...", "providerRef": "fb_4e04053a-...", ...
[gate] confirmation url: http://127.0.0.1:3001/t/acme/order/3e97eeb8-a614-423f-b7c2-5a6b24655e9f
[gate] order heading: Order #1
[gate] payment banner: paid -- Paid. fake-bank settled this order and told us so with a signed
       callback we verified.
[gate] order lines: Anvil, 50kg 2499.00 TRY 1 2499.00 TRY || Total 2499.00 TRY
[gate] my orders: #1  9/22/2026, 8:50:24 AM  placed  2499.00 TRY
[gate] basket link now reads: Basket        (emptied by the confirmation page)
[gate] borg header: Borg Outfitters
[gate] borg accent: #3a4a8f
[gate] borg catalog: Assimilation Jacket | Ocular Implant | Regeneration Alcove
[gate] GATE PASSED
```

Also verified by curl, before the browser run:

- `bad-hash` — fake-bank reports `delivered: false, httpStatus: 401, signatureCorrupted: true`,
  and the storefront logs `refused a bank callback … signature did not verify`. The verification
  path is real.
- a second checkout on acme is order **2**; a fresh database's first acme order is **1** (BG2).
- `/t/nosuchtenant` → **404**.
- `pnpm turbo run typecheck lint --filter @mercatus/storefront --filter @mercatus/ui` → 6/6.
- `next build` succeeds: 11 routes, one static (`/_not-found`), the rest server-rendered.

## State left behind

- Everything this task started is **stopped**: the storefront (3001), the store API (4002),
  fake-bank (4004). The Postgres container `mercatus-sf-gate-pg` was removed. `docker ps` shows
  only what was already running.
- **`apps/storefront` is NOT in `aspire/AppHostA/apphost.cs`.** Task 07a was told to stay inside
  its own directory and two agents were editing the repo concurrently, so the AppHost was left
  alone. Whoever wires it needs, as a `Node`-style executable (`pnpm dev` or `next start`):
  `PORT=3001`, `STORE_API_URL`, `FAKE_BANK_URL`, `FAKE_BANK_HMAC_SECRET`, `STOREFRONT_PUBLIC_URL`,
  and `TENANT_SLUG` only for the dedicated one (3002). `STOREFRONT_PUBLIC_URL` must be an address
  fake-bank can POST to, because that is where its callback goes.
- The storefront does **not** yet show a passive-licence banner. `GET /_meta` reports a licence
  only when the request carries tenant context, and there is no `/t/:slug/_meta`; a 402
  `LICENCE_PASSIVE` from checkout is surfaced as its own sentence in the form instead. Task 08
  owns the licence gate and should decide whether to add a per-tenant meta route.
- Run it by hand:

```bash
cd apps/storefront
STORE_API_URL=http://127.0.0.1:4002 FAKE_BANK_URL=http://127.0.0.1:4004 \
FAKE_BANK_HMAC_SECRET=mercatus-dev-fake-bank-secret-0000000 \
STOREFRONT_PUBLIC_URL=http://127.0.0.1:3001 pnpm dev
```
