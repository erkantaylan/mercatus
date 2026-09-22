/**
 * Every environment variable the storefront reads, parsed once, here (BUILD-PLAN §8.2).
 *
 * Server-only. None of these is `NEXT_PUBLIC_`, and that is deliberate: the browser never talks
 * to the store API directly. It talks to this app's own route handlers, which hold the shopper's
 * bearer token in an httpOnly cookie and the bank's HMAC secret in process memory. A storefront
 * that let the browser call the store API would have to ship the token to the browser, and a
 * dedicated instance would additionally need CORS on someone else's server.
 *
 * `DEPLOYMENT_MODE` is not read here. The storefront's only mode difference is whether
 * `TENANT_SLUG` is set (CC1): set means dedicated and the root path is that one store; unset
 * means pooled and the root path lists the stores this process serves.
 *
 * There is no `server-only` import guarding this: the package is not in the workspace catalog and
 * the guard it provides is already had for free, because nothing here is `NEXT_PUBLIC_` and Next
 * inlines no other variable into client code.
 */

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set (BUILD-PLAN §8.2).`);
  }
  return value;
}

export interface StorefrontConfig {
  readonly storeApiUrl: string;
  readonly fakeBankUrl: string;
  readonly fakeBankHmacSecret: string;
  /** Absolute, because the bank posts its callback from another process. */
  readonly publicUrl: string;
  /** Dedicated deployments pin exactly one tenant; pooled ones leave it undefined. */
  readonly tenantSlug: string | undefined;
  /** Pooled only: which stores the index page offers. Not a lookup -- the API has no such list. */
  readonly tenantSlugs: readonly string[];
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function config(): StorefrontConfig {
  const tenantSlug = process.env['TENANT_SLUG'];
  return {
    storeApiUrl: trimSlash(required('STORE_API_URL', 'http://127.0.0.1:4002')),
    fakeBankUrl: trimSlash(required('FAKE_BANK_URL', 'http://127.0.0.1:4004')),
    fakeBankHmacSecret: required('FAKE_BANK_HMAC_SECRET'),
    publicUrl: trimSlash(required('STOREFRONT_PUBLIC_URL', 'http://127.0.0.1:3001')),
    tenantSlug: tenantSlug === '' ? undefined : tenantSlug,
    tenantSlugs: (process.env['STOREFRONT_TENANT_SLUGS'] ?? 'acme,borg')
      .split(',')
      .map((slug) => slug.trim())
      .filter((slug) => slug !== ''),
  };
}
