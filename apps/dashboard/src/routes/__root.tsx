/**
 * The shell (BUILD-PLAN §7.3): the nav, the licence banner, and the one place the app decides
 * whether anybody is signed in.
 *
 * The guard lives in the root's beforeLoad so that a route cannot be added without it, which is
 * the same reasoning as the store's auth hook: a decision every screen depends on belongs in the
 * pipeline, not in thirty components.
 */
import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, Link, Outlet, redirect, useRouter } from '@tanstack/react-router';
import { useSyncExternalStore } from 'react';

import type { StoreClient } from '../api/client.js';
import type { DashboardAuthAdapter } from '../auth/adapter.js';
import { session } from '../auth/session.js';
import { licenceBanner, useLicence } from '../lib/licence.js';
import { Banner, Button } from '../ui/index.js';

export interface RouterContext {
  readonly client: StoreClient;
  readonly adapter: DashboardAuthAdapter;
  readonly queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: ({ location }) => {
    const signedIn = session.get() !== null;
    if (!signedIn && location.pathname !== '/login') throw redirect({ to: '/login' });
    if (signedIn && location.pathname === '/login') throw redirect({ to: '/products' });
  },
  component: Shell,
});

function Shell() {
  const current = useSyncExternalStore(session.subscribe, session.get);
  if (current === null) return <Outlet />;
  return (
    <div className="mc-shell">
      <TopBar slug={current.slug} role={current.role} />
      <main className="mc-main">
        <LicenceNotice />
        <Outlet />
      </main>
    </div>
  );
}

function TopBar({ slug, role }: { readonly slug: string; readonly role: string }) {
  const router = useRouter();
  const { queryClient } = Route.useRouteContext();
  return (
    <div className="mc-topbar">
      <div className="mc-brand">
        mercatus
        <small>{slug}</small>
      </div>
      <nav className="mc-nav">
        <Link to="/products" activeProps={{ className: 'is-active' }}>
          Products
        </Link>
        <Link to="/orders" activeProps={{ className: 'is-active' }}>
          Orders
        </Link>
        <Link to="/settings" activeProps={{ className: 'is-active' }}>
          Settings
        </Link>
      </nav>
      <span className="mc-badge">{role}</span>
      <Button
        onClick={() => {
          session.clear();
          // The cache holds one tenant's products and orders. Signing out without clearing it
          // would show them to whoever signs in next (BC1).
          queryClient.clear();
          void router.navigate({ to: '/login' });
        }}
      >
        Sign out
      </Button>
    </div>
  );
}

function LicenceNotice() {
  const { client } = Route.useRouteContext();
  // The demo flips a tenant to passive in the platform console and expects the banner within
  // seconds, so this polls rather than waiting for a navigation.
  const licence = useLicence(client);
  if (!licence.data) return null;
  const banner = licenceBanner(licence.data);
  if (banner === null) return null;
  return (
    <div style={{ marginBottom: 'var(--mc-space-4)' }}>
      <Banner tone={banner.tone} title={banner.title}>
        {banner.body}
      </Banner>
    </div>
  );
}
