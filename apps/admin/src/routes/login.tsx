/**
 * The stub operator login (BUILD-PLAN §7.4).
 *
 * It asks for a name and no password, which is honest about what it is: `POST
 * /dev/login/operator` mints an `aud: "operator"` token with no credential check, and the control
 * plane refuses to register that route unless AUTH_ADAPTER=stub. The subject it takes is not
 * decoration -- it is what the control plane logs beside every cross-tenant read an operator
 * performs (BH2), so "who suspended acme" has an answer even in the POC.
 *
 * The Identity phase replaces this screen with an OIDC redirect and nothing else in the app.
 */
import { useNavigate } from '@tanstack/react-router';
import type { FormEvent, ReactNode } from 'react';
import { useState } from 'react';

import { devLoginOperator, PlatformError, PLATFORM_URL } from '../api/client.js';
import { writeSession } from '../auth/session.js';
import { Banner, Button, Card, PageHeader } from '../ui/index.js';

export function LoginPage(): ReactNode {
  const navigate = useNavigate();
  const [subject, setSubject] = useState('dev-operator');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await devLoginOperator(subject.trim());
      writeSession({
        accessToken: result.accessToken,
        expiresAt: result.expiresAt,
        subject: subject.trim(),
      });
      await navigate({ to: '/tenants' });
    } catch (caught) {
      setError(
        caught instanceof PlatformError
          ? `${caught.code}: ${caught.message}`
          : `The control plane at ${PLATFORM_URL} did not answer.`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Sign in"
        subtitle="An operator token, minted by the control plane's stub login. Not a merchant's token."
      />
      <Card>
        <form
          className="mc-form"
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <div className="mc-field">
            <label htmlFor="subject">Operator</label>
            <input
              id="subject"
              className="mc-input"
              data-testid="operator-input"
              value={subject}
              onChange={(event) => {
                setSubject(event.target.value);
              }}
              autoComplete="off"
            />
          </div>
          {error === null ? null : <Banner tone="danger">{error}</Banner>}
          <div>
            <Button
              type="submit"
              tone="primary"
              disabled={busy || subject.trim().length === 0}
              testId="sign-in"
            >
              {busy ? 'Signing in...' : 'Sign in'}
            </Button>
          </div>
          <p className="mc-muted mc-mono">{PLATFORM_URL}</p>
        </form>
      </Card>
    </>
  );
}
