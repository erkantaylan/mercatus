/**
 * `GET /api/auth/callback` -- where the issuer sends the shopper back.
 *
 * THIS URL IS REGISTERED WITH THE ISSUER. `apps/platform/src/identity.ts` puts
 * `${storefrontUrl}/api/auth/callback` on the installation's client at registration time, and
 * `packages/identity/src/bootstrap.ts` does the same for the pooled plane -- both built from the
 * same `STOREFRONT_PUBLIC_URL` this app is started with, so there is no spelling to get wrong
 * (lessons/14).
 *
 * The code is handed straight to the store, which performs the exchange with the client secret it
 * alone holds, and answers with the session IT signed. The browser never sees the token: it goes
 * into an httpOnly cookie on this origin, and this app's server components send it to the store
 * API as a bearer on the shopper's behalf.
 */
import { safeNext } from '@/lib/next-path';
import { exchangeShopperCode, sessionCookies } from '@/lib/session';

export const dynamic = 'force-dynamic';

function failed(message: string): Response {
  // One generic sentence to the browser (S1); the store logged the real reason.
  const body = `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title>
<p data-signin-error="1">${message}</p><p><a href="/signin">Try again</a></p>`;
  return new Response(body, { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) return failed('That sign-in link is incomplete.');

  let exchanged;
  try {
    exchanged = await exchangeShopperCode(code, state);
  } catch {
    return failed('Sign-in did not complete. Start again from the shop.');
  }

  if (exchanged.kind !== 'shopper') {
    // A staff session in a shopper's cookie jar would be a BH1 violation waiting to happen.
    return failed('That account signed in as staff, not as a shopper.');
  }

  const response = new Response(null, {
    status: 302,
    headers: { location: safeNext(exchanged.next) },
  });
  for (const cookie of sessionCookies(exchanged.accessToken, {
    subject: exchanged.subject,
    phone: exchanged.phone,
    name: exchanged.name,
  })) {
    response.headers.append('set-cookie', cookie);
  }
  return response;
}
