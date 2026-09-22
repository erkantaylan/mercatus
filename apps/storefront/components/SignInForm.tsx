/**
 * The sign-in panel.
 *
 * It is a LINK, not a form: signing in is a round trip to the issuer, so the browser has to leave
 * this origin. Under `AUTH_ADAPTER=stub` it lands on the store's own dev sign-in page, which asks
 * for a phone number and nothing else; under `oidc` it lands on Logto. Neither page belongs to
 * this app, and that is the point -- one path, both adapters.
 *
 * Sign-out is still a button, because it is a request to this app and not a navigation to another.
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface Session {
  readonly subject: string;
  readonly phone: string | null;
  readonly name: string | null;
}

export function SignInForm({
  next,
  current,
  label,
}: {
  next: string;
  current: Session | null;
  /** How the store names this person: their phone when it knows one, the subject otherwise. */
  label: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut(): Promise<void> {
    setBusy(true);
    await fetch('/api/session', { method: 'DELETE' });
    setBusy(false);
    router.refresh();
  }

  const href = `/api/auth/login?next=${encodeURIComponent(next)}`;

  return (
    <div className="sf-card sf-stack">
      {current && label ? (
        <p className="sf-muted" data-signed-in-as={label}>
          Signed in as <strong>{label}</strong>. Signing in again replaces the session.
        </p>
      ) : (
        <p className="sf-muted">
          You will be sent to the identity provider and brought straight back here.
        </p>
      )}

      <div className="sf-row">
        {/* A plain anchor, not next/link: this leaves the app entirely. */}
        <a className="sf-button" href={href} data-signin-start="1">
          {current ? 'Sign in as someone else' : 'Sign in'}
        </a>
        {current ? (
          <button
            className="sf-button sf-button-quiet"
            type="button"
            disabled={busy}
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        ) : null}
      </div>
    </div>
  );
}
