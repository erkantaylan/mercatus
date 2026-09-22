/**
 * The shopper's session (BUILD-PLAN §7.2).
 *
 * One httpOnly cookie holding a bearer token the browser can never read. The token is deliberately
 * tenant-less (Q20, BI2): the tenant comes from the route on every request and the subject comes
 * from here, and the store API applies both. That is also why one cookie serves every store in a
 * pooled deployment -- there is nothing tenant-shaped in it to get wrong, so a shopper signs in
 * ONCE and buys from every merchant this process serves.
 *
 * Beside it are two readable cookies holding the phone and the name. They are not credentials --
 * the token is -- they are what the header shows and what goes on the order as contact detail.
 * Keeping them out of the httpOnly cookie is what lets a server component say "buying as +90…"
 * without decoding a JWT it has no key for.
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
export const SHOPPER_PHONE_COOKIE = 'mercatus_shopper_phone';
export const SHOPPER_NAME_COOKIE = 'mercatus_shopper_name';

/** Matches the stub adapter's token lifetime closely enough; the API is the real authority. */
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 8;

export interface ShopperSession {
  readonly phone: string;
  readonly name: string | null;
}

export async function readShopperToken(): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(SHOPPER_COOKIE)?.value;
}

/** Who the browser is signed in as, for the header and for the checkout form. */
export async function readShopperSession(): Promise<ShopperSession | null> {
  const jar = await cookies();
  const token = jar.get(SHOPPER_COOKIE)?.value;
  const phone = jar.get(SHOPPER_PHONE_COOKIE)?.value;
  if (!token || !phone) return null;
  return { phone, name: jar.get(SHOPPER_NAME_COOKIE)?.value ?? null };
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

function serialise(name: string, value: string, maxAge: number, httpOnly: boolean): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${String(maxAge)}`,
    'SameSite=Lax',
  ];
  if (httpOnly) parts.push('HttpOnly');
  return parts.join('; ');
}

/**
 * The three `set-cookie` headers a sign-in writes. `cookies()` is not writable from a Route
 * Handler's return value, so they are built here and appended by the caller.
 */
export function sessionCookies(token: string, session: ShopperSession): readonly string[] {
  return [
    serialise(SHOPPER_COOKIE, token, COOKIE_MAX_AGE_SECONDS, true),
    serialise(SHOPPER_PHONE_COOKIE, session.phone, COOKIE_MAX_AGE_SECONDS, false),
    serialise(SHOPPER_NAME_COOKIE, session.name ?? '', COOKIE_MAX_AGE_SECONDS, false),
  ];
}

/** Sign out: the same three names, expired. */
export function clearedSessionCookies(): readonly string[] {
  return [SHOPPER_COOKIE, SHOPPER_PHONE_COOKIE, SHOPPER_NAME_COOKIE].map((name) =>
    serialise(name, '', 0, name === SHOPPER_COOKIE),
  );
}
