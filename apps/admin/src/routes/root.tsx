/**
 * The shell. Nav, the signed-in operator, and a sign-out.
 *
 * There is no tenant switcher and no "view as merchant": this app talks to the control plane and
 * to nothing else, and it holds a token a store would refuse. That separation is the whole reason
 * it is a second app rather than the dashboard with a flag (BH1).
 */
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { clearSession, useSession } from '../auth/session.js';
import { Button } from '../ui/index.js';

export function RootShell(): ReactNode {
  const navigate = useNavigate();
  const session = useSession();

  return (
    <div className="mc-shell">
      <header className="mc-topbar">
        <div className="mc-brand">
          <span className="mc-brand__mark">mercatus</span>
          <span className="mc-brand__what">platform console</span>
        </div>

        {session === null ? null : (
          <nav className="mc-nav">
            <Link to="/tenants" activeProps={{ className: 'mc-nav--active' }}>
              Tenants
            </Link>
            <Link to="/installations" activeProps={{ className: 'mc-nav--active' }}>
              Installations
            </Link>
          </nav>
        )}

        <div className="mc-topbar__end">
          {session === null ? (
            <span>not signed in</span>
          ) : (
            <>
              <span data-testid="operator-subject">{session.subject}</span>
              <Button
                testId="sign-out"
                onClick={() => {
                  clearSession();
                  void navigate({ to: '/login' });
                }}
              >
                Sign out
              </Button>
            </>
          )}
        </div>
      </header>

      <main className="mc-main">
        <Outlet />
      </main>
    </div>
  );
}
