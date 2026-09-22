/**
 * `DELETE /api/session` -- the shopper signs out of THIS storefront.
 *
 * There is no longer a `POST`. Signing in is a redirect to the issuer and back
 * (`/api/auth/login` -> `/api/auth/callback`), because the store is the OIDC client and this app
 * has no way to mint a token of its own -- which is the whole of the v2.0.0 repair: before it,
 * this route called `/dev/login/shopper`, a route that exists only under `AUTH_ADAPTER=stub`, so
 * turning the real issuer on turned sign-in off.
 *
 * Signing out clears this origin's cookies and nothing else. The session at the ISSUER is not
 * ended: a shopper who signs out at one shop is still recognised at the next one, which is what
 * "one account for every shop" means (Q20). Ending the issuer session is a different button and a
 * different consent.
 */
import { clearedSessionCookies } from '@/lib/session';

export function DELETE(): Response {
  const response = Response.json({ signedOut: true });
  for (const cookie of clearedSessionCookies()) response.headers.append('set-cookie', cookie);
  return response;
}
