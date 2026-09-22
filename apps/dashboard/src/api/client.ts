/**
 * The store API client (BUILD-PLAN §7.3): fetch, plus a Zod parse against @mercatus/contracts.
 *
 * There is no generated client and no hand-written request layer -- decisions-made-overnight.md
 * settled that packages/clients is not built, and this file is the whole alternative. Every
 * response is parsed by the SAME schema the server serialises with, so a contract change that
 * this app has not caught up with is a parse error here rather than `undefined` three components
 * deep.
 *
 * The bearer token is pulled through a getter rather than passed in at every call site: the
 * session owns it, this file only reads it, and nothing that imports the client can reach into
 * the session to change it.
 */
import {
  deleteResultSchema,
  devLoginResultSchema,
  errorEnvelopeSchema,
  licenceViewSchema,
  orderDetailSchema,
  orderListSchema,
  productListSchema,
  productSchema,
  settingsSchema,
  type CreateProductBody,
  type DevLoginResult,
  type LicenceView,
  type OrderDetail,
  type OrderList,
  type PatchProductBody,
  type Product,
  type ProductList,
  type Settings,
} from '@mercatus/contracts';
import type { z } from 'zod';

/**
 * One environment variable is the ONLY difference between the copy that ships beside a pooled
 * store and the copy that ships on a merchant's own server (DK, CC1).
 */
export const STORE_API_URL: string = (
  import.meta.env['VITE_STORE_API_URL'] ?? 'http://localhost:4002'
).replace(/\/+$/, '');

/** The wire error envelope, as an exception. `code` is the stable part; `message` is for a human. */
export class ApiError extends Error {
  public override readonly name = 'ApiError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface StoreClient {
  signInStaff(input: { slug: string; role: 'owner' | 'staff' }): Promise<DevLoginResult>;
  listProducts(): Promise<ProductList>;
  getProduct(id: string): Promise<Product>;
  createProduct(body: CreateProductBody): Promise<Product>;
  patchProduct(id: string, body: PatchProductBody): Promise<Product>;
  deleteProduct(id: string): Promise<void>;
  listOrders(): Promise<OrderList>;
  getOrder(id: string): Promise<OrderDetail>;
  getLicence(): Promise<LicenceView>;
  getSettings(): Promise<Settings>;
}

export function createStoreClient(getToken: () => string | null): StoreClient {
  async function request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    const token = getToken();
    const response = await fetch(`${STORE_API_URL}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const payload: unknown = response.status === 204 ? null : await response.json().catch(() => null);

    if (!response.ok) {
      const envelope = errorEnvelopeSchema.safeParse(payload);
      if (envelope.success) {
        const { code, message, details } = envelope.data.error;
        throw new ApiError(response.status, code, message, details);
      }
      // A non-envelope failure is the edge, the browser or a route that does not exist -- the
      // store itself cannot produce one (core/http/server.ts).
      throw new ApiError(response.status, 'INTERNAL', `${method} ${path} failed (${String(response.status)}).`);
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ApiError(response.status, 'INTERNAL', `${method} ${path} did not match its contract.`, {
        issues: parsed.error.issues,
      });
    }
    return parsed.data;
  }

  return {
    // The stub adapter's dev route. The Identity phase replaces this call and nothing else here.
    signInStaff: (input) => request('POST', '/dev/login/staff', devLoginResultSchema, input),

    // No tenant appears in any path below: the staff token names it, and the store refuses a
    // request whose host or path disagrees (BI1).
    listProducts: () => request('GET', '/api/products', productListSchema),
    getProduct: (id) => request('GET', `/api/products/${id}`, productSchema),
    createProduct: (body) => request('POST', '/api/products', productSchema, body),
    patchProduct: (id, body) => request('PATCH', `/api/products/${id}`, productSchema, body),
    deleteProduct: async (id) => {
      await request('DELETE', `/api/products/${id}`, deleteResultSchema);
    },
    listOrders: () => request('GET', '/api/orders', orderListSchema),
    getOrder: (id) => request('GET', `/api/orders/${id}`, orderDetailSchema),
    getLicence: () => request('GET', '/api/licence', licenceViewSchema),
    getSettings: () => request('GET', '/api/settings', settingsSchema),
  };
}
