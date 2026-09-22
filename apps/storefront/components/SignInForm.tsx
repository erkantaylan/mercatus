/**
 * The sign-in form. It posts to this app's own `/api/session`, which mints the token and writes
 * the httpOnly cookie -- the browser never holds the bearer token, here or anywhere else.
 *
 * `router.replace` plus `router.refresh()` after a successful sign-in: the pages that show who is
 * signed in are server components, so the cookie only becomes visible to them once the router
 * cache is dropped.
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface Session {
  readonly phone: string;
  readonly name: string | null;
}

interface SessionResponse {
  phone?: unknown;
  error?: { code?: unknown; message?: unknown };
}

export function SignInForm({ next, current }: { next: string; current: Session | null }) {
  const router = useRouter();
  const [phone, setPhone] = useState(current?.phone ?? '+905550000001');
  const [name, setName] = useState(current?.name ?? 'Dev Shopper');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone, name }),
      });
      const payload = (await response.json()) as SessionResponse;
      if (!response.ok || typeof payload.phone !== 'string') {
        const code = typeof payload.error?.code === 'string' ? payload.error.code : 'UNKNOWN';
        const message =
          typeof payload.error?.message === 'string' ? payload.error.message : 'Sign-in failed.';
        setError(`${code}: ${message}`);
        setBusy(false);
        return;
      }
      router.replace(next);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in failed.');
      setBusy(false);
    }
  }

  async function signOut(): Promise<void> {
    setBusy(true);
    await fetch('/api/session', { method: 'DELETE' });
    setBusy(false);
    router.refresh();
  }

  return (
    <form className="sf-stack" onSubmit={(event) => void submit(event)}>
      <div className="sf-card sf-stack">
        {current ? (
          <p className="sf-muted" data-signed-in-as={current.phone}>
            Signed in as <strong>{current.phone}</strong>. Signing in again replaces the session.
          </p>
        ) : null}

        <div className="sf-field">
          <label htmlFor="phone">Phone</label>
          <input
            id="phone"
            name="phone"
            className="sf-input"
            value={phone}
            required
            onChange={(event) => {
              setPhone(event.target.value);
            }}
          />
          <span className="sf-hint">E.164, e.g. +905550000001.</span>
        </div>

        <div className="sf-field">
          <label htmlFor="name">Name</label>
          <input
            id="name"
            name="name"
            className="sf-input"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>

        {error ? <p className="sf-error">{error}</p> : null}

        <div className="sf-row">
          <button className="sf-button" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
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
    </form>
  );
}
