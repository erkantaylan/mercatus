/**
 * Sign-in, as one path for both adapters (v2.0.0).
 *
 * There is no longer a stub adapter and an OIDC adapter here. The dashboard starts the STORE's
 * `/auth/login` and finishes at the store's `/auth/exchange`, and which issuer sits in the middle
 * is the store's business: its own dev sign-in page under `AUTH_ADAPTER=stub`, Logto under `oidc`.
 *
 * That is the v2.0.0 repair. This file used to call `/dev/login/staff`, a route registered only
 * when the adapter is the stub -- so turning the real issuer on made the merchant dashboard 404
 * on sign-in, and "real OIDC" and "four working dashboards" could never be true at once.
 *
 * The dashboard holds NO client secret and no issuer URL. It could not: it is a bundle served to
 * a browser, and a secret in one is not a secret (CE1 is the same argument one layer out).
 */
import type { StoreClient } from '../api/client.js';
import type { StaffRole, StaffSession } from './session.js';

export interface DashboardAuthAdapter {
  /** Named so the sign-in page can say which issuer is answering. */
  readonly kind: 'store';
  /** Leaves this origin for the issuer. Never returns. */
  start(input: { slug: string; storeApiUrl: string }): void;
  /** Back from the issuer with a code: hand it to the store and take the session it signs. */
  complete(input: { code: string; state: string }): Promise<StaffSession>;
}

export function createAuthAdapter(client: StoreClient): DashboardAuthAdapter {
  return {
    kind: 'store',

    start({ slug, storeApiUrl }) {
      const url = new URL(`${storeApiUrl}/auth/login`);
      url.searchParams.set('audience', 'staff');
      // `via=dashboard` is what makes the issuer send the code back to THIS origin --
      // `${DASHBOARD_PUBLIC_URL}/callback`, which is exactly the redirect URI the installation
      // registered (apps/platform/src/identity.ts).
      url.searchParams.set('via', 'dashboard');
      url.searchParams.set('slug', slug);
      url.searchParams.set('next', '/products');
      window.location.assign(url.toString());
    },

    async complete({ code, state }) {
      const result = await client.exchange({ code, state });
      if (result.kind !== 'staff') {
        // BH1: a shopper token on the staff surface is a refusal, not a smaller session.
        throw new Error('That account signed in as a shopper, not as staff.');
      }
      if (result.tenantSlug === null) {
        throw new Error('The store did not say which tenant that session is for.');
      }
      const role: StaffRole = result.roles.includes('owner') ? 'owner' : 'staff';
      return {
        accessToken: result.accessToken,
        expiresAt: result.expiresAt,
        slug: result.tenantSlug,
        role,
      };
    },
  };
}
