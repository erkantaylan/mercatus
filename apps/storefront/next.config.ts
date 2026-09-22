import type { NextConfig } from 'next';

/**
 * `@mercatus/ui` ships TypeScript-adjacent source rather than a build (BUILD-PLAN §1) -- in its
 * case two stylesheets -- so Next is told to treat it as part of this app.
 *
 * `@mercatus/contracts` is deliberately NOT here. The storefront imports it for TYPES only; see
 * the note at the top of `lib/api.ts` for why a runtime import of a workspace package does not
 * resolve under either of Next's bundlers.
 */
const nextConfig: NextConfig = {
  // The pooled storefront and a dedicated one are the SAME package (CC1), so two `next dev`
  // processes would otherwise share `apps/storefront/.next` and trip over each other's build
  // output. One variable per instance keeps them apart; unset is the plain default.
  distDir: process.env['NEXT_DIST_DIR'] ?? '.next',

  // Next 16 writes an AGENTS.md and a CLAUDE.md into the app directory on first start. This repo
  // keeps its guidance in docs/ and lessons/, so the generator is off.
  agentRules: false,

  // `next dev` treats 127.0.0.1 as a different origin from localhost and silently refuses the
  // dev-only requests hydration waits on: the page renders, the HMR socket connects, and no
  // handler is ever attached. The only symptom is that nothing on the page does anything, and
  // the one line that says why is in the dev server's own log, not the browser's console.
  // Everything in this repo is curled and driven at 127.0.0.1, so it is allowed here.
  // `shop.localtest.me` is the same app through the edge on 8080, which is how the demo is meant
  // to be reachable through one port.
  //
  // `*.localtest.me` is every dedicated instance: since there can be several at once, each one is
  // driven at a hostname of ITS OWN (`<slug>.localtest.me:<port>`) rather than at another port on
  // `localhost`. Cookies are scoped by host and ignore the port, so two storefronts on `localhost`
  // share one jar and the second sign-in destroys the first store's session -- a checkout that
  // answers UNAUTHENTICATED on a page still naming the shopper. A hostname per box is what a real
  // deployment gives them anyway.
  allowedDevOrigins: ['127.0.0.1', 'shop.localtest.me', 'localtest.me', '*.localtest.me'],
  transpilePackages: ['@mercatus/ui'],
};

export default nextConfig;
