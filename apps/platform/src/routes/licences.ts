/**
 * The licence endpoints (BUILD-PLAN §6.1, CG1, CG3, CE4).
 *
 *   GET /tenants/:slug/licence          what a data plane POLLS. It pulls; we never push.
 *   GET /tenants/:slug/licence/signed   the same facts as a JWT, verifiable with no network.
 *   GET /licence/jwks                   the public key, so "no network" is actually true.
 *
 * The signed licence is what makes the flagship demo possible: a store on someone else's server
 * keeps selling while this process is stopped, because it already holds a licence it can check
 * against a cached key. Nothing in the pair lets that box mint a licence -- the private key never
 * leaves here (CE1).
 *
 * An instance token may read its OWN tenant and no other. That is BI1 arriving through a
 * credential rather than a route: a disagreement is a refusal, never a widening.
 */
import { errorEnvelopeSchema, licencePollResultSchema, tenantSchema } from '@mercatus/contracts';
import type { MercatusServer } from '@mercatus/core';
import { NotFoundError, TenantNotFoundError } from '@mercatus/core';
import { findLicence, findTenantBySlug } from '@mercatus/db-platform';

import { assertMayReadTenant, requireOperatorOrInstance } from '../auth.js';
import type { PlatformDeps } from '../deps.js';
import { licencePollDto } from '../mappers.js';
import { jwksSchema, signedLicenceSchema } from '../schemas.js';

const slugParams = tenantSchema.pick({ slug: true });

export function registerLicenceRoutes(app: MercatusServer, deps: PlatformDeps): void {
  app.get(
    '/licence/jwks',
    {
      schema: {
        summary: 'The public key licences are signed with',
        description:
          'A data plane fetches this once and caches it. Verification is then offline, which ' +
          'is what keeps a dedicated store selling while the control plane is down (CG1).',
        tags: ['licence'],
        response: { 200: jwksSchema },
      },
    },
    () => deps.licences.jwks(),
  );

  app.get(
    '/tenants/:slug/licence',
    {
      preHandler: requireOperatorOrInstance(deps),
      schema: {
        summary: 'What a data plane polls for',
        tags: ['licence'],
        security: [{ bearer: [] }],
        params: slugParams,
        response: {
          200: licencePollResultSchema,
          401: errorEnvelopeSchema,
          403: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
        },
      },
    },
    async (req) => {
      const tenant = await findTenantBySlug(deps.db, req.params.slug);
      if (!tenant) throw new TenantNotFoundError();
      assertMayReadTenant(req, tenant.id);
      return licencePollDto(tenant, await findLicence(deps.db, tenant.id));
    },
  );

  app.get(
    '/tenants/:slug/licence/signed',
    {
      preHandler: requireOperatorOrInstance(deps),
      schema: {
        summary: 'The signed licence -- a JWT the data plane verifies offline',
        description:
          'Ed25519. `exp` is the end of the licence period, not a session lifetime: the grace ' +
          'window for an unreachable control plane is a separate clock, kept in the data plane.',
        tags: ['licence'],
        security: [{ bearer: [] }],
        params: slugParams,
        response: {
          200: signedLicenceSchema,
          401: errorEnvelopeSchema,
          403: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
        },
      },
    },
    async (req) => {
      const tenant = await findTenantBySlug(deps.db, req.params.slug);
      if (!tenant) throw new TenantNotFoundError();
      assertMayReadTenant(req, tenant.id);
      const licence = await findLicence(deps.db, tenant.id);
      if (!licence) {
        // A pending tenant has no licence to sign, and signing an empty one would hand a box a
        // document saying it may operate. The absence is the answer.
        throw new NotFoundError('That tenant has no licence yet.', {
          logDetail: `tenant ${tenant.slug} is ${tenant.status}`,
        });
      }
      return deps.licences.sign(tenant, licence);
    },
  );
}
