/**
 * Sign in (BUILD-PLAN §7.3, rebuilt for v2.0.0).
 *
 * The slug is the only thing this page asks for, and it is not a credential: it selects the
 * ORGANIZATION the login is for, so the issuer can mint a token scoped to one tenant and no other
 * (BC1, CD3). Everything else happens at the issuer -- the store's own dev sign-in page under
 * `AUTH_ADAPTER=stub`, Logto under `oidc` -- and the browser comes back to `/callback`.
 *
 * Submitting navigates away, so there is no `busy` state to unwind and no error this page can
 * report. What comes back wrong comes back to `/callback`, which says so there.
 */
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';

import { STORE_API_URL } from '../api/client.js';
import { Button, Card, Field, Input } from '../ui/index.js';

export const Route = createFileRoute('/login')({ component: LoginPage });

function LoginPage() {
  const { adapter } = Route.useRouteContext();
  const [slug, setSlug] = useState('acme');

  return (
    <div className="mc-login">
      <Card>
        <form
          className="mc-stack"
          onSubmit={(event) => {
            event.preventDefault();
            adapter.start({ slug, storeApiUrl: STORE_API_URL });
          }}
        >
          <div>
            <h1>mercatus</h1>
            <p className="mc-muted">Merchant dashboard &middot; sign in at the identity provider</p>
          </div>

          <Field label="Store" htmlFor="slug" hint="The tenant slug, e.g. acme or borg.">
            <Input
              id="slug"
              name="slug"
              value={slug}
              autoComplete="off"
              onChange={(event) => setSlug(event.target.value)}
            />
          </Field>

          <Button type="submit" variant="primary" disabled={slug.length < 2}>
            Sign in
          </Button>
        </form>
      </Card>
    </div>
  );
}
