/**
 * The shopper's session (BUILD-PLAN §7.2, rebuilt for v2.0.0).
 *
 * One httpOnly cookie holding a bearer token the browser can never read. The token is the STORE'S
 * OWN session (`packages/core/src/auth/session.ts`), minted by the store at the end of an OIDC
 * round trip and verified by the store against a key it holds -- which is what keeps a dedicated
 * instance selling to signed-in shoppers while the control plane is down (Q20, CG1).
 *
 * It is deliberately tenant-less (Q20, BI2): the tenant comes from the route on every request and
 * the subject comes from here, and the store API applies both. That is also why one cookie serves
 * every store in a pooled deployment -- there is nothing tenant-shaped in it to get wrong, so a
 * shopper signs in ONCE and buys from every merchant this process serves.
 *
 * WHAT CHANGED IN v2.0.0. This file used to POST `${storeApiUrl}/dev/login/shopper`, a route that
 * exists only while `AUTH_ADAPTER=stub`. Under `oidc` it 404'd and sign-in answered 502, so "real
 * OIDC" and "a browser you can shop in" could never be true at once. Now the storefront starts
 * the store's own `/auth/login` and finishes at `/auth/exchange`, which is ONE code path for both
 * adapters: under the stub the issuer is the store's dev sign-in page, under oidc it is Logto.
 * The storefront holds no client secret either way -- the store is the OIDC client.
 *
 * Beside the token are three readable cookies: the subject (who the store thinks this is), and
 * the phone and name that go on an order as contact detail. They are not credentials -- the token
 * is -- they are what the header shows and what prefills the checkout form. Keeping them out of
 * the httpOnly cookie is what lets a server component say "buying as …" without decoding a JWT it
 * has no key for.
 */
import type { ExchangeResult } from '@mercatus/contracts';
import { cookies } from 'next/headers';

import { config } from '@/lib/config';

export const SHOPPER_COOKIE = 'mercatus_shopper';
/** The issuer's subject. Always present for a signed-in shopper; opaque under a real issuer. */
export const SHOPPER_ID_COOKIE = 'mercatus_shopper_id';
export const SHOPPER_PHONE_COOKIE = 'mercatus_shopper_phone';
export const SHOPPER_NAME_COOKIE = 'mercatus_shopper_name';

/** Matches the store session's lifetime closely enough; the API is the real authority. */
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 8;

export interface ShopperSession {
  readonly subject: string;
  /**
   * Contact detail, not identity (BI2). The stub issuer's subject spells a phone out, so it is
   * known at sign-in; a real issuer's subject does not, so the checkout form asks once and this
   * remembers the answer.
   */
  readonly phone: string | null;
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
  const subject = jar.get(SHOPPER_ID_COOKIE)?.value;
  if (!token || !subject) return null;
  const phone = jar.get(SHOPPER_PHONE_COOKIE)?.value;
  const name = jar.get(SHOPPER_NAME_COOKIE)?.value;
  return {
    subject,
    phone: phone === undefined || phone === '' ? null : phone,
    name: name === undefined || name === '' ? null : name,
  };
}

/** What the header and the checkout page show. The phone when we have one, the subject otherwise. */
export function shopperLabel(session: ShopperSession): string {
  return session.phone ?? session.subject;
}

/**
 * Where to send the browser to sign in: the store's `/auth/login`, which 302s on to the issuer.
 *
 * `via=storefront` is what makes the issuer send the code back HERE rather than to the store's own
 * callback -- and `${STOREFRONT_PUBLIC_URL}/api/auth/callback` is exactly the redirect URI the
 * instance registers, so the URI that is registered and the URI that is sent come from one
 * variable (lessons/14: Logto matches redirect_uri as a string).
 */
export function shopperLoginUrl(next: string): string {
  const { storeApiUrl } = config();
  const url = new URL(`${storeApiUrl}/auth/login`);
  url.searchParams.set('audience', 'shopper');
  url.searchParams.set('via', 'storefront');
  url.searchParams.set('next', next);
  return url.toString();
}

/** A failed exchange, with the store's own error code where there is one. */
export class ShopperLoginError extends Error {
  public override readonly name = 'ShopperLoginError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Finish the round trip: hand the authorization code to the store, which is the only process here
 * holding a client secret, and get back the session it signed.
 */
export async function exchangeShopperCode(code: string, state: string): Promise<ExchangeResult> {
  const { storeApiUrl } = config();
  const response = await fetch(`${storeApiUrl}/auth/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ code, state }),
    cache: 'no-store',
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const envelope = payload as { error?: { code?: unknown; message?: unknown } } | null;
    const errorCode = typeof envelope?.error?.code === 'string' ? envelope.error.code : 'UNAUTHENTICATED';
    const message =
      typeof envelope?.error?.message === 'string' ? envelope.error.message : 'Sign-in did not complete.';
    throw new ShopperLoginError(response.status, errorCode, message);
  }
  return payload as ExchangeResult;
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
 * The four `set-cookie` headers a sign-in writes. `cookies()` is not writable from a Route
 * Handler's return value, so they are built here and appended by the caller.
 */
export function sessionCookies(token: string, session: ShopperSession): readonly string[] {
  return [
    serialise(SHOPPER_COOKIE, token, COOKIE_MAX_AGE_SECONDS, true),
    serialise(SHOPPER_ID_COOKIE, session.subject, COOKIE_MAX_AGE_SECONDS, false),
    serialise(SHOPPER_PHONE_COOKIE, session.phone ?? '', COOKIE_MAX_AGE_SECONDS, false),
    serialise(SHOPPER_NAME_COOKIE, session.name ?? '', COOKIE_MAX_AGE_SECONDS, false),
  ];
}

/** Sign out: the same four names, expired. */
export function clearedSessionCookies(): readonly string[] {
  return [SHOPPER_COOKIE, SHOPPER_ID_COOKIE, SHOPPER_PHONE_COOKIE, SHOPPER_NAME_COOKIE].map((name) =>
    serialise(name, '', 0, name === SHOPPER_COOKIE),
  );
}
