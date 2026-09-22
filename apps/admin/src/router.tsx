/**
 * The route tree, written in code rather than generated from files.
 *
 * @tanstack/router-plugin is in the catalog but at 1.168.40 against a router at 1.170.38, and a
 * generated `routeTree.gen.ts` is a committed artifact that lint and typecheck then have to be
 * told to ignore. Five routes do not need a code generator. Recorded in
 * docs/decisions-made-overnight.md.
 */
import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';

import { readSession } from './auth/session.js';
import { InstallationsPage } from './routes/installations.index.js';
import { LoginPage } from './routes/login.js';
import { RootShell } from './routes/root.js';
import { TenantDetailPage } from './routes/tenants.detail.js';
import { TenantsPage } from './routes/tenants.index.js';

const rootRoute = createRootRoute({ component: RootShell });

/**
 * The guard. It only decides whether a SCREEN renders -- the control plane decides what the token
 * may read, and it is the one that matters. A console that hid a button but sent the request
 * anyway would be exactly the "one app with a flag" mistake wearing a different hat (BH1).
 */
function requireOperator(): void {
  if (readSession() === null) throw redirect({ to: '/login' });
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: readSession() === null ? '/login' : '/tenants' });
  },
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

const tenantsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tenants',
  beforeLoad: requireOperator,
  component: TenantsPage,
});

const tenantDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tenants/$slug',
  beforeLoad: requireOperator,
  component: TenantDetailPage,
});

const installationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/installations',
  beforeLoad: requireOperator,
  component: InstallationsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  tenantsRoute,
  tenantDetailRoute,
  installationsRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
