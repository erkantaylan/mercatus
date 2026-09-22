/**
 * Auth behind an adapter interface from day one -- a standing decision, and the reason the
 * Identity phase is a new file here rather than a rewrite of every route.
 *
 * The stub talks to the store's own `/dev/login/staff`, which mints a tenant-scoped token with no
 * credential check at all. That route only exists under AUTH_ADAPTER=stub and refuses to register
 * otherwise, so this adapter cannot accidentally be the one running beside a real issuer.
 */
import type { StoreClient } from '../api/client.js';
import type { StaffRole, StaffSession } from './session.js';

export interface SignInInput {
  readonly slug: string;
  readonly role: StaffRole;
}

export interface DashboardAuthAdapter {
  /** Named so the sign-in page can say which one is answering. */
  readonly kind: 'stub' | 'oidc';
  signIn(input: SignInInput): Promise<StaffSession>;
}

/** AUTH_ADAPTER=stub. Slug + role, no password, dev only. */
export function createStubAuthAdapter(client: StoreClient): DashboardAuthAdapter {
  return {
    kind: 'stub',
    async signIn({ slug, role }) {
      const result = await client.signInStaff({ slug, role });
      return { accessToken: result.accessToken, expiresAt: result.expiresAt, slug, role };
    },
  };
}
