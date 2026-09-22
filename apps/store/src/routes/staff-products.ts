/**
 * `/api/products` -- the merchant's own catalog (BUILD-PLAN §6.2).
 *
 * BI1: the tenant comes from the TOKEN. The auth hook already refused the request if the host or
 * the path named a different one, so by the time a handler runs there is exactly one tenant in
 * play and no handler has to remember to check.
 *
 * Nothing below names a tenant. `findProductById(tx, id)` on another merchant's product id
 * returns nothing, because the transaction is scoped by RLS -- which is why a forgotten predicate
 * here is a 404 rather than a leak (BE1, §3.5).
 */
import {
  createProductBodySchema,
  deleteResultSchema,
  errorEnvelopeSchema,
  idParamsSchema,
  pageQuerySchema,
  patchProductBodySchema,
  productListSchema,
  productSchema,
} from '@mercatus/contracts';
import type { MercatusServer } from '@mercatus/core';
import { ConflictError, normalisePageRequest, ProductNotFoundError, requireStaff } from '@mercatus/core';
import {
  deleteProduct,
  findProductById,
  insertProduct,
  listProducts,
  updateProduct,
} from '@mercatus/db-store';

import type { StoreDeps } from '../deps.js';
import { productDto } from '../mappers.js';
import { inTenantTx } from '../tx.js';

/**
 * Drizzle wraps every driver error as `Failed query: …` and hangs the real PostgresError off
 * `.cause`, so a constraint name is only findable by walking the chain (lessons/02).
 */
function violates(error: unknown, constraint: string): boolean {
  for (let cause: unknown = error; cause != null; cause = (cause as { cause?: unknown }).cause) {
    const text = (cause as { message?: string }).message ?? '';
    if (text.includes(constraint)) return true;
  }
  return false;
}

/** (tenant_id, sku) is the composite unique (BG1); a duplicate is this merchant's, not another's. */
const SKU_UNIQUE = 'products_tenant_sku_uq';

export function registerStaffProductRoutes(app: MercatusServer, deps: StoreDeps): void {
  app.get(
    '/api/products',
    {
      preHandler: requireStaff(),
      schema: {
        summary: 'The catalog, as staff see it',
        tags: ['staff'],
        security: [{ bearer: [] }],
        querystring: pageQuerySchema,
        response: { 200: productListSchema, 401: errorEnvelopeSchema, 403: errorEnvelopeSchema },
      },
    },
    async (req) => {
      const page = normalisePageRequest(req.query);
      const { items, total } = await inTenantTx(deps, req, (tx) => listProducts(tx, page));
      return { items: items.map(productDto), total };
    },
  );

  app.get(
    '/api/products/:id',
    {
      preHandler: requireStaff(),
      schema: {
        summary: 'One product',
        tags: ['staff'],
        security: [{ bearer: [] }],
        params: idParamsSchema,
        response: { 200: productSchema, 401: errorEnvelopeSchema, 404: errorEnvelopeSchema },
      },
    },
    async (req) => {
      const row = await inTenantTx(deps, req, (tx) => findProductById(tx, req.params.id));
      if (!row) throw new ProductNotFoundError();
      return productDto(row);
    },
  );

  app.post(
    '/api/products',
    {
      preHandler: requireStaff(),
      schema: {
        summary: 'Add a product',
        tags: ['staff'],
        security: [{ bearer: [] }],
        body: createProductBodySchema,
        response: {
          201: productSchema,
          401: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        // The tenant id is written from the context, never taken from the body. RLS's `with
        // check` would refuse anything else anyway; this means the refusal never has to happen.
        const row = await inTenantTx(deps, req, (tx, ctx) =>
          insertProduct(tx, ctx.tenantId, {
            sku: req.body.sku,
            title: req.body.title,
            priceMinor: req.body.priceMinor,
            ...(req.body.currency === undefined ? {} : { currency: req.body.currency }),
            imageUrl: req.body.imageUrl ?? null,
            stock: req.body.stock,
          }),
        );
        reply.status(201);
        return productDto(row);
      } catch (error) {
        if (violates(error, SKU_UNIQUE)) {
          throw new ConflictError(`SKU "${req.body.sku}" is already in this catalog.`, {
            details: { sku: req.body.sku },
            cause: error,
          });
        }
        throw error;
      }
    },
  );

  app.patch(
    '/api/products/:id',
    {
      preHandler: requireStaff(),
      schema: {
        summary: 'Change a product',
        tags: ['staff'],
        security: [{ bearer: [] }],
        params: idParamsSchema,
        // .partial().strict(): an unknown key is a 400, not a 200 that changed nothing.
        body: patchProductBodySchema,
        response: {
          200: productSchema,
          400: errorEnvelopeSchema,
          401: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
        },
      },
    },
    async (req) => {
      try {
        const row = await inTenantTx(deps, req, (tx) => updateProduct(tx, req.params.id, req.body));
        if (!row) throw new ProductNotFoundError();
        return productDto(row);
      } catch (error) {
        if (violates(error, SKU_UNIQUE)) {
          throw new ConflictError('That SKU is already in this catalog.', { cause: error });
        }
        throw error;
      }
    },
  );

  app.delete(
    '/api/products/:id',
    {
      preHandler: requireStaff(),
      schema: {
        summary: 'Remove a product',
        tags: ['staff'],
        security: [{ bearer: [] }],
        params: idParamsSchema,
        response: {
          200: deleteResultSchema,
          401: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
        },
      },
    },
    async (req) => {
      let deleted: boolean;
      try {
        deleted = await inTenantTx(deps, req, (tx) => deleteProduct(tx, req.params.id));
      } catch (error) {
        // An order line keeps the price and title it was sold at, but it still references the
        // product. Removing it would rewrite history, so this is a refusal, not a cascade.
        if (violates(error, 'order_lines_product_id')) {
          throw new ConflictError('That product appears on an order and cannot be removed.', {
            cause: error,
          });
        }
        throw error;
      }
      // False means unknown -- or another merchant's, which RLS makes the same thing.
      if (!deleted) throw new ProductNotFoundError();
      return { deleted: true as const };
    },
  );
}
