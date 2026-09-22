/**
 * `/callback` -- where the issuer sends the merchant back.
 *
 * THIS URL IS REGISTERED WITH THE ISSUER as `${DASHBOARD_PUBLIC_URL}/callback`, by
 * `apps/platform/src/identity.ts` for a dedicated instance and by
 * `packages/identity/src/bootstrap.ts` for the pooled plane. Both build it from the same variable
 * the dashboard is served on, so the URI that is registered and the URI that is sent are one
 * string (lessons/14).
 *
 * The code goes straight to the store, which holds the client secret and performs the exchange.
 * What comes back is the store's own session token -- the same credential its cookie carries --
 * and it is kept exactly where the dev token used to be.
 */
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { ApiError } from '../api/client.js';
import { session } from '../auth/session.js';
import { Card } from '../ui/index.js';

export const Route = createFileRoute('/callback')({
  // The root guard would bounce a signed-out browser to /login before this ever ran.
  beforeLoad: () => ({}),
  validateSearch: (search: Record<string, unknown>) => ({
    code: typeof search['code'] === 'string' ? search['code'] : undefined,
    state: typeof search['state'] === 'string' ? search['state'] : undefined,
  }),
  component: CallbackPage,
});

function CallbackPage() {
  const { adapter } = Route.useRouteContext();
  const { code, state } = Route.useSearch();
  const router = useRouter();
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (code === undefined || state === undefined) {
      setError('That sign-in link is incomplete. Start again from the sign-in page.');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const staff = await adapter.complete({ code, state });
        if (cancelled) return;
        session.set(staff);
        await router.navigate({ to: '/products' });
      } catch (cause) {
        if (cancelled) return;
        setError(
          cause instanceof ApiError
            ? `${cause.code}: ${cause.message}`
            : cause instanceof Error
              ? cause.message
              : 'Sign-in did not complete.',
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adapter, code, state, router]);

  return (
    <div className="mc-login">
      <Card>
        <div className="mc-stack">
          <h1>mercatus</h1>
          {error === undefined ? (
            <p className="mc-muted">Finishing sign-in…</p>
          ) : (
            <>
              <p className="mc-error" data-signin-error="1">
                {error}
              </p>
              <p className="mc-muted">
                <a href="/login">Back to sign-in</a>
              </p>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
