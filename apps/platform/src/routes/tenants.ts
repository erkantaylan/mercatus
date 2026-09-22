/**
 * `/tenants` -- the console's surface (BUILD-PLAN §6.1).
 *
 * A tenant id is MINTED here (BV1). Nothing in this file accepts one from outside, and
 * `payment_ref` is written as an attribute of the row, never as its identity: the failure that
 * rule comes from is a customer who cancels, resubscribes, gets a new subscription id and comes
 * back as a different tenant with none of their data.
 *
 * Provisioning is a named, tested operation rather than a script someone runs (CK1), and every
 * step of it is idempotent: creating a tenant that already exists in `pending` returns the one
 * that is there, so a buyer who retries a failed payment resumes rather than colliding (CK2).
 */
import {
  errorEnvelopeSchema,
  pageQuerySchema,
  setLicenceBodySchema,
  tenantListSchema,
  tenantSchema,
  tenantSummarySchema,
} from '@mercatus/contracts';
import type { MercatusServer } from '@mercatus/core';
import { ConflictError, normalisePageRequest, TenantNotFoundError } from '@mercatus/core';
import {
  findTenantDetailBySlug,
  insertTenant,
  issueLicence,
  listTenantDetail,
  setTenantStatus,
} from '@mercatus/db-platform';

import { requireOperator } from '../auth.js';
import type { PlatformDeps } from '../deps.js';
import { defaultValidUntil } from '../licence.js';
import { tenantDto, tenantSummaryDto } from '../mappers.js';
import { activateTenantBodySchema, createTenantBodySchema } from '../schemas.js';

/** `{ slug }` in the path. The slug is public surface; the uuid is the key (BV3). */
const slugParams = tenantSchema.pick({ slug: true });

export function registerTenantRoutes(app: MercatusServer, deps: PlatformDeps): void {
  app.get(
    '/tenants',
    {
      preHandler: requireOperator(deps),
      schema: {
        summary: 'Every tenant, with its licence and its last heartbeat',
        tags: ['console'],
        security: [{ bearer: [] }],
        querystring: pageQuerySchema,
        response: { 200: tenantListSchema, 401: errorEnvelopeSchema },
      },
    },
    async (req) => {
      const page = normalisePageRequest(req.query);
      const { items, total } = await listTenantDetail(deps.db, page);
      return { items: items.map(tenantSummaryDto), total };
    },
  );

  app.get(
    '/tenants/:slug',
    {
      preHandler: requireOperator(deps),
      schema: {
        summary: 'One tenant',
        tags: ['console'],
        security: [{ bearer: [] }],
        params: slugParams,
        response: { 200: tenantSummarySchema, 401: errorEnvelopeSchema, 404: errorEnvelopeSchema },
      },
    },
    async (req) => {
      const detail = await findTenantDetailBySlug(deps.db, req.params.slug);
      if (!detail) throw new TenantNotFoundError();
      return tenantSummaryDto(detail);
    },
  );

  app.post(
    '/tenants',
    {
      preHandler: requireOperator(deps),
      schema: {
        summary: 'Create a tenant, pending. It takes no money and grants no licence',
        tags: ['console'],
        security: [{ bearer: [] }],
        body: createTenantBodySchema,
        response: { 201: tenantSchema, 401: errorEnvelopeSchema, 409: errorEnvelopeSchema },
      },
    },
    async (req, reply) => {
      const existing = await findTenantDetailBySlug(deps.db, req.body.slug);
      if (existing) {
        throw new ConflictError(`The slug "${req.body.slug}" is taken.`, {
          details: { slug: req.body.slug },
        });
      }
      const row = await insertTenant(deps.db, {
        slug: req.body.slug,
        name: req.body.name,
        tier: req.body.tier,
      });
      reply.status(201);
      return tenantDto(row);
    },
  );

  app.post(
    '/tenants/:slug/activate',
    {
      preHandler: requireOperator(deps),
      schema: {
        summary: 'Activate a tenant and issue its licence, without a payment',
        description:
          'The manual path beside the buy-a-store flow: trials, internal demo stores and ' +
          'merchants onboarded by hand. Idempotent -- activating an active tenant re-issues.',
        tags: ['console'],
        security: [{ bearer: [] }],
        params: slugParams,
        body: activateTenantBodySchema,
        response: { 200: tenantSummarySchema, 401: errorEnvelopeSchema, 404: errorEnvelopeSchema },
      },
    },
    async (req) => {
      const detail = await findTenantDetailBySlug(deps.db, req.params.slug);
      if (!detail) throw new TenantNotFoundError();

      await deps.db.transaction(async (tx) => {
        await setTenantStatus(tx, detail.tenant.id, 'active');
        await issueLicence(tx, {
          tenantId: detail.tenant.id,
          validUntil: req.body.validUntil ?? defaultValidUntil(),
          ...(req.body.entitlements === undefined ? {} : { entitlements: req.body.entitlements }),
        });
      });

      const after = await findTenantDetailBySlug(deps.db, req.params.slug);
      if (!after) throw new TenantNotFoundError();
      req.log.info({ tenant: after.tenant.slug, by: req.platformPrincipal }, 'tenant activated');
      return tenantSummaryDto(after);
    },
  );

  app.post(
    '/tenants/:slug/licence',
    {
      preHandler: requireOperator(deps),
      schema: {
        summary: 'Flip a tenant between active and passive (ES, CG3)',
        description:
          'Passive blocks the money-making action and leaves everything else alone: the ' +
          'storefront still browses, the dashboard stays fully usable, and nothing is deleted. ' +
          'It is never set because WE could not be reached -- that is a different state, ' +
          'computed in the data plane, and the two are never collapsed.',
        tags: ['console'],
        security: [{ bearer: [] }],
        params: slugParams,
        body: setLicenceBodySchema,
        response: {
          200: tenantSummarySchema,
          401: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
        },
      },
    },
    async (req) => {
      const detail = await findTenantDetailBySlug(deps.db, req.params.slug);
      if (!detail) throw new TenantNotFoundError();
      if (detail.tenant.status === 'pending') {
        // A tenant that has never been activated has nothing to suspend. Saying so is more use
        // to the operator than silently inventing a licence.
        throw new ConflictError('That tenant is still pending; activate it first.', {
          details: { slug: detail.tenant.slug, status: detail.tenant.status },
        });
      }

      await deps.db.transaction(async (tx) => {
        await setTenantStatus(tx, detail.tenant.id, req.body.status);
        const validUntil = req.body.validUntil ?? detail.licence?.validUntil ?? defaultValidUntil();
        const entitlements = req.body.entitlements ?? detail.licence?.entitlements ?? {};
        await issueLicence(tx, { tenantId: detail.tenant.id, validUntil, entitlements });
      });

      const after = await findTenantDetailBySlug(deps.db, req.params.slug);
      if (!after) throw new TenantNotFoundError();
      req.log.info(
        { tenant: after.tenant.slug, status: req.body.status, by: req.platformPrincipal },
        'licence status set',
      );
      return tenantSummaryDto(after);
    },
  );
}
