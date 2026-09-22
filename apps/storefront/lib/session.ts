/**
 * The shopper's session (BUILD-PLAN §7.2).
 *
 * One httpOnly cookie holding a bearer token the browser can never read. The token is deliberately
 * tenant-less (Q20, BI2): the tenant comes from the route on every request and the subject comes
 * from here, and the store API applies both. That is also why one cookie serves every store in a
 * pooled deployment -- there is nothing tenant-shaped in it to get wrong.
 *
 * Today the token is minted by the store API's `/dev/login/shopper`, which exists only while
 * AUTH_ADAPTER=stub. In the Identity phase this file becomes an OIDC code exchange and the cookie
 * stops changing at all: the store performs the login once and issues its own session, so a
 * dedicated instance keeps serving signed-in shoppers while the control plane is down (Q20).
 */
import type { DevLoginResult } from '@mercatus/contracts';
import { cookies } from 'next/headers';

import { config } from '@/lib/config';

export const SHOPPER_COOKIE = 'mercatus_shopper';

/** Matches the stub adapter's token lifetime closely enough; the API is the real authority. */
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 8;

export async function readShopperToken(): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(SHOPPER_COOKIE)?.value;
}

/**
 * Mints a token for this phone number and returns it. The caller sets the cookie, because a
 * server component may not.
 */
export async function mintShopperToken(phone: string): Promise<string> {
  const { storeApiUrl } = config();
  const response = await fetch(`${storeApiUrl}/dev/login/shopper`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ phone }),
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Shopper login failed: ${String(response.status)}`);
  }
  const { accessToken } = (await response.json()) as DevLoginResult;
  return accessToken;
}

export function shopperCookie(token: string): {
  name: string;
  value: string;
  httpOnly: true;
  sameSite: 'lax';
  path: string;
  maxAge: number;
} {
  return {
    name: SHOPPER_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE_SECONDS,
  };
}
