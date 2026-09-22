/**
 * `/api/orders` -- what the merchant sees (BUILD-PLAN §6.2).
 *
 * Staff see every order in their own store, which is what separates this from the shopper list in
 * public.ts: there the subject condition is applied as well (BI2), here it deliberately is not.
 * The tenant is still the token's and still enforced by RLS, so "every order" cannot quietly
 * become "every order on the box".
 */
import {
  errorEnvelopeSchema,
  idParamsSchema,
  orderDetailSchema,
  orderListSchema,
  pageQuerySchema,
} from '@mercatus/contracts';
import type { MercatusServer } from '@mercatus/core';
import { normalisePageRequest, OrderNotFoundError, requireStaff } from '@mercatus/core';
import { findOrderById, listOrders } from '@mercatus/db-store';

import type { StoreDeps } from '../deps.js';
import { orderDetailDto, orderDto } from '../mappers.js';
import { inTenantTx } from '../tx.js';

export function registerStaffOrderRoutes(app: MercatusServer, deps: StoreDeps): void {
  app.get(
    '/api/orders',
    {
      preHandler: requireStaff(),
      schema: {
        summary: 'Orders, newest first',
        tags: ['staff'],
        security: [{ bearer: [] }],
        querystring: pageQuerySchema,
        response: { 200: orderListSchema, 401: errorEnvelopeSchema, 403: errorEnvelopeSchema },
      },
    },
    async (req) => {
      const page = normalisePageRequest(req.query);
      const { items, total } = await inTenantTx(deps, req, (tx) => listOrders(tx, page));
      return { items: items.map(orderDto), total };
    },
  );

  app.get(
    '/api/orders/:id',
    {
      preHandler: requireStaff(),
      schema: {
        summary: 'One order, with its lines',
        tags: ['staff'],
        security: [{ bearer: [] }],
        params: idParamsSchema,
        response: { 200: orderDetailSchema, 401: errorEnvelopeSchema, 404: errorEnvelopeSchema },
      },
    },
    async (req) => {
      const found = await inTenantTx(deps, req, (tx) => findOrderById(tx, req.params.id));
      if (!found) throw new OrderNotFoundError();
      return orderDetailDto(found.order, found.lines);
    },
  );
}
