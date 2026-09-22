/**
 * Installations -- provisioning a dedicated instance (architecture.md §7, CE1, CE4, CE7).
 *
 * Every arrow is OUTBOUND FROM THEIR BOX. We hand an operator a one-time bootstrap token; the
 * instance presents it once, is given a per-instance credential, and from then on it registers,
 * pulls its licence and pushes telemetry. Nothing here reaches into their network, and no SSH,
 * callback port or VPN appears anywhere in the design -- the day support needs one, this is an
 * on-prem support business rather than a product.
 *
 * Tokens are generated here, shown once, and stored only as sha256 hashes. A dump of the table
 * yields nothing that can be presented.
 */
import { randomBytes } from 'node:crypto';

import {
  createInstallationBodySchema,
  createInstallationResultSchema,
  errorEnvelopeSchema,
  registerInstallationBodySchema,
  registerInstallationResultSchema,
} from '@mercatus/contracts';
import type { MercatusServer } from '@mercatus/core';
import { ConflictError, TenantNotFoundError, UnauthenticatedError } from '@mercatus/core';
import {
  completeRegistration,
  findInstallationByBootstrapHash,
  findTenantById,
  findTenantBySlug,
  hashToken,
  insertInstallation,
  listRegisteredInstallations,
} from '@mercatus/db-platform';

import { requireOperator } from '../auth.js';
import type { PlatformDeps } from '../deps.js';
import { installationDto } from '../mappers.js';
import { installationListSchema } from '../schemas.js';

/** 32 bytes of randomness, base64url. Long enough that the contract's `min(32)` is satisfied. */
function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

export function registerInstallationRoutes(app: MercatusServer, deps: PlatformDeps): void {
  app.post(
    '/installations',
    {
      preHandler: requireOperator(deps),
      schema: {
        summary: 'Hand out a one-time bootstrap token for a dedicated instance',
        description: 'The token is shown exactly once. It is stored only as a hash.',
        tags: ['console'],
        security: [{ bearer: [] }],
        body: createInstallationBodySchema,
        response: {
          201: createInstallationResultSchema,
          401: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
        },
      },
    },
    async (req, reply) => {
      const tenant = await findTenantBySlug(deps.db, req.body.tenantSlug);
      if (!tenant) throw new TenantNotFoundError();
      if (tenant.tier !== 'dedicated') {
        throw new ConflictError('Only a dedicated tenant runs on its own server.', {
          details: { slug: tenant.slug, tier: tenant.tier },
        });
      }
      const bootstrapToken = mintToken();
      const row = await insertInstallation(deps.db, {
        tenantId: tenant.id,
        bootstrapTokenHash: hashToken(bootstrapToken),
      });
      req.log.info({ tenant: tenant.slug, installationId: row.id }, 'bootstrap token issued');
      reply.status(201);
      return { installationId: row.id, bootstrapToken };
    },
  );

  app.post(
    '/installations/register',
    {
      schema: {
        summary: 'An instance registers itself, burning its bootstrap token',
        description:
          'Authenticated by the bootstrap token in the body -- the instance has no other ' +
          'credential yet. The token is spent here and can never be presented again (CE1).',
        tags: ['installations'],
        body: registerInstallationBodySchema,
        response: {
          200: registerInstallationResultSchema,
          401: errorEnvelopeSchema,
        },
      },
    },
    async (req) => {
      const bootstrapHash = hashToken(req.body.bootstrapToken);
      const pending = await findInstallationByBootstrapHash(deps.db, bootstrapHash);
      if (!pending) {
        // One generic answer whether the token is unknown, already spent or revoked (S1).
        throw new UnauthenticatedError(undefined, {
          logDetail: 'bootstrap token matches no unspent installation',
        });
      }

      const instanceToken = mintToken();
      const row = await completeRegistration(deps.db, {
        bootstrapTokenHash: bootstrapHash,
        instanceTokenHash: hashToken(instanceToken),
        version: req.body.version,
      });
      if (!row) {
        // Two boxes raced the same one-time token; the second update matched no rows.
        throw new UnauthenticatedError(undefined, {
          logDetail: 'bootstrap token was spent between lookup and update',
        });
      }

      const tenant = await findTenantById(deps.db, row.tenantId);
      if (!tenant) throw new TenantNotFoundError();
      req.log.info(
        { installationId: row.id, tenant: tenant.slug, version: req.body.version },
        'installation registered',
      );
      return {
        installationId: row.id,
        instanceToken,
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
      };
    },
  );

  app.get(
    '/installations',
    {
      preHandler: requireOperator(deps),
      schema: {
        summary: 'Registered instances, and what they last reported',
        description:
          'Version, licence id and the two counts are REPORTED by a machine whose owner has ' +
          'root. Telemetry, never metering (CE3, CJ1).',
        tags: ['console'],
        security: [{ bearer: [] }],
        response: { 200: installationListSchema, 401: errorEnvelopeSchema },
      },
    },
    async () => {
      const rows = await listRegisteredInstallations(deps.db);
      const items = [];
      for (const row of rows) {
        const tenant = await findTenantById(deps.db, row.tenantId);
        items.push(installationDto(row, tenant?.slug ?? 'unknown'));
      }
      return { items, total: items.length };
    },
  );
}
