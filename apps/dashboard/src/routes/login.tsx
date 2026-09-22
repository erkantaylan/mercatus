/**
 * Sign in (BUILD-PLAN §7.3). Slug + role, because the adapter answering is the STUB: the store's
 * `/dev/login/staff` mints a tenant-scoped token with no credential check, and only exists while
 * AUTH_ADAPTER=stub.
 *
 * The form knows none of that. It calls `adapter.signIn`, and the Identity phase swaps the
 * adapter for one that redirects to the issuer without this page changing shape.
 */
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useState } from 'react';

import { ApiError } from '../api/client.js';
import { session, type StaffRole } from '../auth/session.js';
import { Button, Card, Field, Input } from '../ui/index.js';

export const Route = createFileRoute('/login')({ component: LoginPage });

function LoginPage() {
  const { adapter } = Route.useRouteContext();
  const router = useRouter();
  const [slug, setSlug] = useState('acme');
  const [role, setRole] = useState<StaffRole>('owner');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      session.set(await adapter.signIn({ slug, role }));
      await router.navigate({ to: '/products' });
    } catch (cause) {
      // TENANT_NOT_FOUND is the interesting one: a slug this store does not serve. Anything else
      // is the API being down, which the message says plainly rather than blaming the merchant.
      setError(
        cause instanceof ApiError
          ? `${cause.code}: ${cause.message}`
          : 'The store API did not answer. Is it running?',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mc-login">
      <Card>
        <form
          className="mc-stack"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div>
            <h1>mercatus</h1>
            <p className="mc-muted">Merchant dashboard &middot; {adapter.kind} sign-in</p>
          </div>

          <Field label="Store" htmlFor="slug" hint="The tenant slug, e.g. acme or borg." error={error}>
            <Input
              id="slug"
              name="slug"
              value={slug}
              autoComplete="off"
              onChange={(event) => setSlug(event.target.value)}
            />
          </Field>

          <Field label="Role" htmlFor="role">
            <select
              id="role"
              className="mc-input"
              value={role}
              onChange={(event) => setRole(event.target.value as StaffRole)}
            >
              <option value="owner">owner</option>
              <option value="staff">staff</option>
            </select>
          </Field>

          <Button type="submit" variant="primary" disabled={busy || slug.length < 2}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
