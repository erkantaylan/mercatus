/**
 * Typed fetch against the store API (BUILD-PLAN §7.2).
 *
 * The shapes come from `@mercatus/contracts` as **types only**. That is a deliberate retreat from
 * "parse every response with the contract's Zod schema", and the reason is mechanical: every
 * relative import inside the workspace packages carries a `.js` extension that TypeScript maps
 * back to `.ts` (lesson 01), and neither Turbopack nor webpack does that mapping -- so importing
 * the contracts package at RUNTIME makes it resolve to a module with no exports at all. A
 * type-only import is erased before any bundler sees it, needs no resolution, and still fails
 * `pnpm turbo run typecheck` the moment the store API's contract changes underneath this app.
 * That is the half of the guarantee worth having; the other half was buying a runtime re-check of
 * a reply that the API already serialised through the same schema.
 *
 * Server-side only. The shopper's bearer token lives in an httpOnly cookie and is read by route
 * handlers and server components; it never reaches the browser.
 */
import type {
  CheckoutBody,
  CheckoutResult,
  ErrorEnvelopeShape,
  OrderDetail,
  OrderList,
  Product,
  ProductList,
  StoreBranding,
} from '@mercatus/contracts';

import { config } from '@/lib/config';

/**
 * A non-2xx from the store API, with the error code the API chose. The code is what the UI
 * branches on -- `LICENCE_PASSIVE` is a different sentence from `INSUFFICIENT_STOCK`, and neither
 * is "something went wrong".
 */
export class StoreApiError extends Error {
  public override readonly name = 'StoreApiError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface RequestOptions {
  readonly token?: string | undefined;
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
}

/** The envelope is the one shape every non-2xx in this repo uses (§6.0). */
function errorFrom(status: number, payload: unknown): StoreApiError {
  const envelope = payload as Partial<ErrorEnvelopeShape> | null;
  const error = envelope?.error;
  if (error && typeof error.code === 'string' && typeof error.message === 'string') {
    return new StoreApiError(status, error.code, error.message);
  }
  // Something other than the shared envelope came back. Keep the status; be honest about the code.
  return new StoreApiError(status, 'UNPARSEABLE_ERROR', `${String(status)} from the store API`);
}

async function call<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { storeApiUrl } = config();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.token) headers['authorization'] = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${storeApiUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    // Stock is on the catalog pages, so nothing here may be served from a cache (ER).
    cache: 'no-store',
  });

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw errorFrom(response.status, payload);
  return payload as T;
}

export function getBranding(slug: string): Promise<StoreBranding> {
  return call(`/t/${slug}/branding`);
}

export function listProducts(slug: string): Promise<ProductList> {
  return call(`/t/${slug}/products`);
}

export function getProduct(slug: string, id: string): Promise<Product> {
  return call(`/t/${slug}/products/${id}`);
}

export function checkout(slug: string, token: string, body: CheckoutBody): Promise<CheckoutResult> {
  return call(`/t/${slug}/checkout`, { method: 'POST', body, token });
}

export function listOrders(slug: string, token: string): Promise<OrderList> {
  return call(`/t/${slug}/orders`, { token });
}

export function getOrder(slug: string, token: string, id: string): Promise<OrderDetail> {
  return call(`/t/${slug}/orders/${id}`, { token });
}
