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
  // Next 16 writes an AGENTS.md and a CLAUDE.md into the app directory on first start. This repo
  // keeps its guidance in docs/ and lessons/, so the generator is off.
  agentRules: false,

  // `next dev` treats 127.0.0.1 as a different origin from localhost and silently refuses the
  // dev-only requests hydration waits on: the page renders, the HMR socket connects, and no
  // handler is ever attached. The only symptom is that nothing on the page does anything, and
  // the one line that says why is in the dev server's own log, not the browser's console.
  // Everything in this repo is curled and driven at 127.0.0.1, so it is allowed here.
  allowedDevOrigins: ['127.0.0.1'],
  transpilePackages: ['@mercatus/ui'],
};

export default nextConfig;
