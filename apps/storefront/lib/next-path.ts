/**
 * Where a sign-in may send the browser afterwards.
 *
 * Same-site paths only. Anything else -- a scheme, a host, a protocol-relative `//` -- is home.
 * An open redirect on a sign-in page is the classic one, and the value makes a round trip through
 * an issuer before it comes back, so it is checked on the way out AND on the way in.
 */
export function safeNext(value: string | undefined | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}
