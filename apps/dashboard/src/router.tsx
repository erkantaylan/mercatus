/**
 * The router (BUILD-PLAN §7.3). File-based: @tanstack/router-plugin reads src/routes/* and writes
 * src/routeTree.gen.ts, which is committed so that `turbo run typecheck` does not depend on a dev
 * server having run first.
 *
 * The context carries the API client and the auth adapter, so no route reaches for a module-level
 * singleton and a test can hand a route a different one.
 */
import { createRouter } from '@tanstack/react-router';

import type { RouterContext } from './routes/__root.js';
import { routeTree } from './routeTree.gen';

export function createAppRouter(context: RouterContext) {
  return createRouter({
    routeTree,
    context,
    defaultPreload: 'intent',
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
