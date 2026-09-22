/**
 * The shopper and public surface, all of it under `/t/:slug` (BUILD-PLAN §6.2).
 *
 * BI2 in one sentence: a shopper's token is deliberately tenant-less, so the tenant comes from
 * the ROUTE and the subject comes from the TOKEN, and both conditions are applied to every read.
 * The tenant half is RLS's -- which is why nothing below names a tenant -- and the subject half
 * is written out, because it is not something the database can infer.
 *
 * `/t/:slug/orders/:id` answers 404 for someone else's order, never 403: a 403 confirms that the
 * order exists (S1).
 */
import {
  errorEnvelopeSchema,
  orderDetailSchema,
  orderListSchema,
  pageQuerySchema,
  productListSchema,
  productSchema,
  storeBrandingSchema,
  tenantResourceParamsSchema,
  tenantSlugParamsSchema,
} from '@mercatus/contracts';
import type { MercatusServer, TenantContext } from '@mercatus/core';
import {
  normalisePageRequest,
  OrderNotFoundError,
  ProductNotFoundError,
  requireShopper,
  TenantNotFoundError,
  UnauthenticatedError,
} from '@mercatus/core';
import {
  findOrderById,
  findProductById,
  findShopperBySubject,
  findTenantById,
  listOrdersForSubject,
  listProducts,
} from '@mercatus/db-store';

import type { StoreDeps } from '../deps.js';
import { brandingDto, orderDetailDto, orderDto, productDto } from '../mappers.js';
import { inTenantTx } from '../tx.js';

/** The token half of BI2. Absent means the guard let something through it should not have. */
function subjectOf(ctx: TenantContext): string {
  if (!ctx.subject) throw new UnauthenticatedError(undefined, { logDetail: 'shopper context carries no subject' });
  return ctx.subject;
}

export function registerPublicRoutes(app: MercatusServer, deps: StoreDeps): void {
  app.get(
    '/t/:slug/branding',
    {
      schema: {
        summary: 'Store name and branding, for the storefront shell',
        tags: ['public'],
        params: tenantSlugParamsSchema,
        response: { 200: storeBrandingSchema, 404: errorEnvelopeSchema },
      },
    },
    async (req) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new TenantNotFoundError();
      const row = await findTenantById(deps.db, ctx.tenantId);
      if (!row) throw new TenantNotFoundError();
      return brandingDto(row);
    },
  );

  app.get(
    '/t/:slug/products',
    {
      schema: {
        summary: 'Public catalog',
        tags: ['public'],
        params: tenantSlugParamsSchema,
        querystring: pageQuerySchema,
        response: { 200: productListSchema, 404: errorEnvelopeSchema },
      },
    },
    async (req) => {
      const page = normalisePageRequest(req.query);
      const { items, total } = await inTenantTx(deps, req, (tx) => listProducts(tx, page));
      return { items: items.map(productDto), total };
    },
  );

  app.get(
    '/t/:slug/products/:id',
    {
      schema: {
        summary: 'One product from the public catalog',
        tags: ['public'],
        params: tenantResourceParamsSchema,
        response: { 200: productSchema, 404: errorEnvelopeSchema },
      },
    },
    async (req) => {
      const row = await inTenantTx(deps, req, (tx) => findProductById(tx, req.params.id));
      // Another merchant's product id is invisible inside this transaction, so this is a 404
      // rather than a cross-tenant read (BE1).
      if (!row) throw new ProductNotFoundError();
      return productDto(row);
    },
  );

  app.get(
    '/t/:slug/orders',
    {
      preHandler: requireShopper(),
      schema: {
        summary: "This shopper's orders at this store",
        tags: ['public'],
        security: [{ bearer: [] }],
        params: tenantSlugParamsSchema,
        querystring: pageQuerySchema,
        response: { 200: orderListSchema, 401: errorEnvelopeSchema, 403: errorEnvelopeSchema },
      },
    },
    async (req) => {
      const page = normalisePageRequest(req.query);
      const { items, total } = await inTenantTx(deps, req, (tx, ctx) =>
        listOrdersForSubject(tx, subjectOf(ctx), page),
      );
      return { items: items.map(orderDto), total };
    },
  );

  app.get(
    '/t/:slug/orders/:id',
    {
      preHandler: requireShopper(),
      schema: {
        summary: 'One of this shopper’s orders, with its lines',
        tags: ['public'],
        security: [{ bearer: [] }],
        params: tenantResourceParamsSchema,
        response: { 200: orderDetailSchema, 401: errorEnvelopeSchema, 404: errorEnvelopeSchema },
      },
    },
    async (req) => {
      const found = await inTenantTx(deps, req, async (tx, ctx) => {
        const shopper = await findShopperBySubject(tx, subjectOf(ctx));
        const order = await findOrderById(tx, req.params.id);
        if (!order || !shopper || order.order.shopperId !== shopper.id) return null;
        return order;
      });
      // 404 for someone else's order. A 403 would confirm it exists (S1).
      if (!found) throw new OrderNotFoundError();
      return orderDetailDto(found.order, found.lines);
    },
  );
}
