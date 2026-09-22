/**
 * `GET /api/auth/login` -- start the shopper's sign-in.
 *
 * It is a 302 and nothing else: the store decides where the issuer lives, because the store is the
 * OIDC client. Under `AUTH_ADAPTER=stub` that is the store's own dev sign-in page; under `oidc` it
 * is Logto. This app holds no client id, no client secret and no issuer URL, and that is the point
 * -- one code path, both adapters, and a dedicated instance on someone else's server never holds a
 * credential of ours beyond its own (CE1).
 */
import { redirect } from 'next/navigation';

import { safeNext } from '@/lib/next-path';
import { shopperLoginUrl } from '@/lib/session';

export const dynamic = 'force-dynamic';

export function GET(request: Request): never {
  const next = safeNext(new URL(request.url).searchParams.get('next') ?? undefined);
  // `redirect()` throws; Next turns it into the 307 the browser follows.
  redirect(shopperLoginUrl(next));
}
