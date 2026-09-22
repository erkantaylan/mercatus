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
import {
  ConflictError,
  NotFoundError,
  TenantNotFoundError,
  UnauthenticatedError,
} from '@mercatus/core';
import {
  completeRegistration,
  deleteInstallation,
  findInstallationByBootstrapHash,
  findInstallationById,
  findTenantById,
  findTenantBySlug,
  hashToken,
  insertInstallation,
  listRegisteredInstallations,
  setLogtoApplication,
} from '@mercatus/db-platform';
import { z } from 'zod';

import { requireOperator } from '../auth.js';
import type { PlatformDeps } from '../deps.js';
import { installationDto } from '../mappers.js';
import { installationListSchema } from '../schemas.js';

/** 32 bytes of randomness, base64url. Long enough that the contract's `min(32)` is satisfied. */
function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * HOST PINNING (GK). The security of the whole v2.0.0 handshake is this function.
 *
 * `POST /installations/register` turns whatever URL the caller reports into a REDIRECT URI at the
 * issuer. A redirect URI is where authorization codes are delivered. So a bootstrap token that
 * leaks -- out of a terminal history, a ticket, a screenshot -- becomes a token-exfiltration
 * vector the moment its holder can register `https://evil.example/auth/callback`: they then send
 * a member of that tenant's staff at a perfectly genuine sign-in page and collect the code.
 *
 * The installation therefore records ONE hostname when its token is minted, and every URL
 * reported at registration must be on it. The port is deliberately free: a dedicated instance's
 * port is assigned by its own orchestrator and is unknowable when the token is handed out, which
 * is the entire reason this handshake exists.
 *
 * Returns the reason it failed, for the LOG. The caller gets one generic answer (S1).
 */
function hostMismatch(expectedHost: string | null, urls: (string | undefined)[]): string | null {
  if (expectedHost === null) {
    // Pre-v2.0.0 row, minted before host pinning existed. Refuse rather than register blind:
    // an unpinned installation is exactly the vector above, and re-minting a token is one curl.
    return 'installation has no expectedHost (minted before host pinning); re-mint the token';
  }
  for (const raw of urls) {
    if (raw === undefined) continue;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return `reported URL is not a URL: ${raw}`;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `reported URL is not http(s): ${raw}`;
    }
    if (parsed.hostname.toLowerCase() !== expectedHost.toLowerCase()) {
      return `reported host ${parsed.hostname} does not match expectedHost ${expectedHost} (${raw})`;
    }
  }
  return null;
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
        // The token is only ever spendable at this host (GK). Not optional, and not defaulted:
        // an operator who does not know where the box will live has nothing to pin, and an
        // unpinned installation is a redirect URI an attacker chooses.
        expectedHost: req.body.expectedHost,
      });
      req.log.info(
        { tenant: tenant.slug, installationId: row.id, expectedHost: req.body.expectedHost },
        'bootstrap token issued',
      );
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

      // BEFORE the token is burned, on purpose. A host mismatch is far more often a typo in
      // somebody's own configuration than an attack, and burning the token on a typo bricks the
      // install for good. An attacker gains nothing from the retry: they never get past this
      // line, and the answer is the same 401 an unknown token gets (S1).
      const mismatch = hostMismatch(pending.expectedHost, [
        req.body.baseUrl,
        req.body.dashboardUrl,
        req.body.storefrontUrl,
      ]);
      if (mismatch) {
        req.log.warn(
          { installationId: pending.id, expectedHost: pending.expectedHost, reason: mismatch },
          'registration refused: host pinning',
        );
        throw new UnauthenticatedError(undefined, { logDetail: `host pinning: ${mismatch}` });
      }

      const instanceToken = mintToken();
      const row = await completeRegistration(deps.db, {
        bootstrapTokenHash: bootstrapHash,
        instanceTokenHash: hashToken(instanceToken),
        version: req.body.version,
        baseUrl: req.body.baseUrl,
        dashboardUrl: req.body.dashboardUrl ?? null,
        storefrontUrl: req.body.storefrontUrl ?? null,
      });
      if (!row) {
        // Two boxes raced the same one-time token; the second update matched no rows.
        throw new UnauthenticatedError(undefined, {
          logDetail: 'bootstrap token was spent between lookup and update',
        });
      }

      const tenant = await findTenantById(deps.db, row.tenantId);
      if (!tenant) throw new TenantNotFoundError();

      // Now the issuer. This is the arrow that used to run the other way: A no longer guesses
      // where this box lives, it is TOLD, and it registers exactly that (CE4 is untouched --
      // every call here is ours to Logto, none of them is ours to the instance).
      //
      // Identity being unavailable is NOT a failed registration. The box is registered, it has
      // its licence and its per-instance token, and it is told `oidc: null` so it keeps whatever
      // identity configuration it already had. A control plane that refused to provision because
      // the issuer had a bad afternoon is the failure CG1 exists to prevent.
      let oidc: {
        issuer: string;
        clientId: string;
        clientSecret: string;
        organizationId: string | null;
      } | null = null;
      try {
        const provisioned = await deps.identity.provision(tenant.slug, row.id, {
          baseUrl: row.baseUrl ?? req.body.baseUrl,
          dashboardUrl: row.dashboardUrl,
          storefrontUrl: row.storefrontUrl,
        });
        if (provisioned) {
          await setLogtoApplication(deps.db, {
            id: row.id,
            logtoApplicationId: provisioned.applicationId,
          });
          oidc = {
            issuer: provisioned.issuer,
            clientId: provisioned.clientId,
            clientSecret: provisioned.clientSecret,
            organizationId: provisioned.organizationId,
          };
        } else {
          req.log.warn(
            { installationId: row.id, reason: deps.identity.lastError() },
            'registered without an issuer client: no Management API credential',
          );
        }
      } catch (error) {
        req.log.error(
          { installationId: row.id, err: error },
          'registered, but the issuer refused the redirect URIs',
        );
      }

      req.log.info(
        {
          installationId: row.id,
          tenant: tenant.slug,
          version: req.body.version,
          baseUrl: row.baseUrl,
          oidc: oidc === null ? 'none' : oidc.clientId,
        },
        'installation registered',
      );
      return {
        installationId: row.id,
        instanceToken,
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        oidc,
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

  app.delete(
    '/installations/:id',
    {
      preHandler: requireOperator(deps),
      schema: {
        summary: 'Deprovision an instance',
        description:
          'Built at the same time as provisioning, never after it (CK1). Deletes the client ' +
          "this instance was given at the issuer and takes its redirect URIs back out of the " +
          'shared ones -- otherwise the list grows for ever and every box we ever retired keeps ' +
          'a working client secret. The instance token dies with the row.',
        tags: ['console'],
        security: [{ bearer: [] }],
        params: z.object({ id: z.uuid() }),
        response: { 204: z.null(), 401: errorEnvelopeSchema, 404: errorEnvelopeSchema },
      },
    },
    async (req, reply) => {
      const row = await findInstallationById(deps.db, req.params.id);
      if (!row) throw new NotFoundError('No such installation.');

      // The issuer first. If the row went first and this threw, the application would be orphaned
      // with nothing left pointing at it.
      const removed = await deps.identity.deprovision({
        applicationId: row.logtoApplicationId,
        urls:
          row.baseUrl === null
            ? null
            : {
                baseUrl: row.baseUrl,
                dashboardUrl: row.dashboardUrl,
                storefrontUrl: row.storefrontUrl,
              },
      });

      await deleteInstallation(deps.db, row.id);
      req.log.info(
        { installationId: row.id, tenant: row.tenantId, issuerCleaned: removed },
        'installation deprovisioned',
      );
      reply.status(204);
      return null;
    },
  );
}
