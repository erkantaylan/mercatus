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
  reportInstallationBodySchema,
  reportInstallationResultSchema,
} from '@mercatus/contracts';
import type { MercatusServer } from '@mercatus/core';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TenantNotFoundError,
  UnauthenticatedError,
} from '@mercatus/core';
import type { InstallationRow, TenantRow } from '@mercatus/db-platform';
import {
  completeRegistration,
  deleteInstallation,
  findInstallationByBootstrapHash,
  findInstallationById,
  findTenantById,
  findTenantBySlug,
  hashToken,
  insertInstallation,
  listOtherInstallations,
  listRegisteredInstallations,
  setLogtoApplication,
  updateReportedUrls,
} from '@mercatus/db-platform';
import { z } from 'zod';

import { requireInstance, requireOperator } from '../auth.js';
import type { PlatformDeps } from '../deps.js';
import type { InstanceUrls } from '../identity.js';
import { normaliseReportedUrl, reportedHost } from '../identity.js';
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
 * is the entire reason this handshake exists. (The pin NARROWS the vector; it does not close it.
 * Anyone who can bind a port on the pinned host can still receive the callback, which on a dev
 * topology where everything is `localhost` is worth saying out loud.)
 *
 * It also returns the ONE spelling of each URL that will be stored and registered. Checking one
 * string and storing another is how `oidc.invalid_redirect_uri` gets back in (lessons/14):
 * `normaliseReportedUrl` lower-cases the authority, drops a default port and refuses userinfo, a
 * query and a fragment, so what was validated is character-for-character what Logto is told.
 *
 * Failure returns the reason, for the LOG. The caller gets one generic answer (S1).
 */
function checkReportedUrls(
  expectedHost: string | null,
  reported: { baseUrl: string; dashboardUrl?: string | undefined; storefrontUrl?: string | undefined },
): { urls: InstanceUrls } | { reason: string } {
  if (expectedHost === null) {
    // Pre-v2.0.0 row, minted before host pinning existed. Refuse rather than register blind:
    // an unpinned installation is exactly the vector above, and re-minting a token is one curl.
    return { reason: 'installation has no expectedHost (minted before host pinning); re-mint the token' };
  }
  const pin = expectedHost.toLowerCase();
  const one = (field: string, raw: string): { url: string } | { reason: string } => {
    const host = reportedHost(raw);
    if (host === null) return { reason: `reported ${field} is not a URL: ${raw}` };
    if (host !== pin) {
      return { reason: `reported host ${host} does not match expectedHost ${expectedHost} (${raw})` };
    }
    const normalised = normaliseReportedUrl(raw);
    return 'reason' in normalised ? { reason: `${field}: ${normalised.reason}` } : normalised;
  };

  const base = one('baseUrl', reported.baseUrl);
  if ('reason' in base) return base;

  const optional: { dashboardUrl: string | null; storefrontUrl: string | null } = {
    dashboardUrl: null,
    storefrontUrl: null,
  };
  for (const field of ['dashboardUrl', 'storefrontUrl'] as const) {
    const raw = reported[field];
    if (raw === undefined) continue;
    const checked = one(field, raw);
    if ('reason' in checked) return checked;
    optional[field] = checked.url;
  }
  return { urls: { baseUrl: base.url, ...optional } };
}

/** What an installation reported, as the issuer half of this file wants it. */
function rowUrls(row: InstallationRow): InstanceUrls | null {
  return row.baseUrl === null
    ? null
    : { baseUrl: row.baseUrl, dashboardUrl: row.dashboardUrl, storefrontUrl: row.storefrontUrl };
}

/**
 * Tell the issuer where this instance lives, and hand back the client it may use.
 *
 * Shared by registration and re-reporting, because they are the same operation with a different
 * credential at the door. Three properties are deliberate and each of them was a defect first:
 *
 *   - the application id is written to our row the MOMENT the client exists, before anything
 *     else can throw. Otherwise a failing PATCH on a shared application leaves a confidential
 *     client with a live secret at the issuer that deprovisioning can never reach.
 *   - `oidc` is null only when identity is genuinely unavailable. A failure AFTER the client
 *     exists is a warning in our log, not an instance told it has no issuer client and quietly
 *     coming up with no OIDC at all.
 *   - every other installation's addresses go in, so the shared dashboard and storefront clients
 *     keep the callbacks somebody else is still serving on.
 */
async function provisionIssuer(
  deps: PlatformDeps,
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void },
  row: InstallationRow,
  tenant: TenantRow,
  urls: InstanceUrls,
  previous: InstanceUrls | null,
): Promise<{ issuer: string; clientId: string; clientSecret: string; organizationId: string | null } | null> {
  try {
    const others = (await listOtherInstallations(deps.db, row.id)).flatMap((other) => {
      const theirs = rowUrls(other);
      return theirs === null ? [] : [theirs];
    });
    const provisioned = await deps.identity.provision({
      tenantSlug: tenant.slug,
      installationId: row.id,
      urls,
      ownership: { previous, others },
      onApplicationCreated: async (applicationId) => {
        await setLogtoApplication(deps.db, { id: row.id, logtoApplicationId: applicationId });
      },
    });
    if (!provisioned) {
      log.warn(
        { installationId: row.id, reason: deps.identity.lastError() },
        'no issuer client: no Management API credential',
      );
      return null;
    }
    for (const warning of provisioned.warnings) {
      log.warn({ installationId: row.id, warning }, 'issuer client minted, with a warning');
    }
    return {
      issuer: provisioned.issuer,
      clientId: provisioned.clientId,
      clientSecret: provisioned.clientSecret,
      organizationId: provisioned.organizationId,
    };
  } catch (error) {
    log.error({ installationId: row.id, err: error }, 'the issuer refused this instance');
    return null;
  }
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
      const checked = checkReportedUrls(pending.expectedHost, {
        baseUrl: req.body.baseUrl,
        dashboardUrl: req.body.dashboardUrl,
        storefrontUrl: req.body.storefrontUrl,
      });
      if ('reason' in checked) {
        req.log.warn(
          { installationId: pending.id, expectedHost: pending.expectedHost, reason: checked.reason },
          'registration refused: host pinning',
        );
        throw new UnauthenticatedError(undefined, { logDetail: `host pinning: ${checked.reason}` });
      }

      const instanceToken = mintToken();
      const row = await completeRegistration(deps.db, {
        bootstrapTokenHash: bootstrapHash,
        instanceTokenHash: hashToken(instanceToken),
        version: req.body.version,
        // The NORMALISED spelling, not the caller's: this is the string Logto will be given and
        // the string a later re-report is diffed against.
        baseUrl: checked.urls.baseUrl,
        dashboardUrl: checked.urls.dashboardUrl,
        storefrontUrl: checked.urls.storefrontUrl,
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
      const oidc = await provisionIssuer(deps, req.log, row, tenant, checked.urls, null);

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
        tenantName: tenant.name,
        oidc,
      };
    },
  );

  // -------------------------------------------------------------------------------------------
  // The same conversation, repeatable, with the credential the instance already holds.
  //
  // A dedicated box's port is assigned by its own orchestrator. It restarts, it comes back
  // somewhere else, and the redirect URI we registered for the old address answers `400` at the
  // issuer -- observed, with a live Logto, on a plain restart of AppHost B. Registration cannot
  // fix that: it happens once, and the bootstrap token that authorised it was burned.
  //
  // So the instance re-reports on every boot (`apps/store/src/provision.ts`). CE4 is untouched:
  // this is still their box calling us.
  // -------------------------------------------------------------------------------------------
  app.post(
    '/installations/report',
    {
      preHandler: requireInstance(deps),
      schema: {
        summary: 'A registered instance says where it lives now',
        description:
          'Host-pinned exactly as registration is. Its port is assigned by its own ' +
          'orchestrator, so an instance that restarts has a new address and the redirect URI ' +
          'we hold for the old one is a login that fails at the issuer.',
        tags: ['installations'],
        security: [{ bearer: [] }],
        body: reportInstallationBodySchema,
        response: {
          200: reportInstallationResultSchema,
          401: errorEnvelopeSchema,
          403: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
        },
      },
    },
    async (req) => {
      const principal = req.platformPrincipal;
      if (principal?.kind !== 'instance') throw new ForbiddenError();

      const current = await findInstallationById(deps.db, principal.installationId);
      if (!current) throw new NotFoundError('No such installation.');

      const checked = checkReportedUrls(current.expectedHost, {
        baseUrl: req.body.baseUrl,
        dashboardUrl: req.body.dashboardUrl,
        storefrontUrl: req.body.storefrontUrl,
      });
      if ('reason' in checked) {
        req.log.warn(
          { installationId: current.id, expectedHost: current.expectedHost, reason: checked.reason },
          'report refused: host pinning',
        );
        throw new UnauthenticatedError(undefined, { logDetail: `host pinning: ${checked.reason}` });
      }

      const previous = rowUrls(current);
      const row = await updateReportedUrls(deps.db, {
        id: current.id,
        version: req.body.version,
        baseUrl: checked.urls.baseUrl,
        dashboardUrl: checked.urls.dashboardUrl,
        storefrontUrl: checked.urls.storefrontUrl,
      });
      if (!row) throw new NotFoundError('No such installation.');

      const tenant = await findTenantById(deps.db, row.tenantId);
      if (!tenant) throw new TenantNotFoundError();

      const moved =
        previous === null ||
        previous.baseUrl !== checked.urls.baseUrl ||
        previous.dashboardUrl !== checked.urls.dashboardUrl ||
        previous.storefrontUrl !== checked.urls.storefrontUrl;

      // The issuer is reconciled on EVERY report, not only a move: it is idempotent, it costs one
      // GET when nothing changed, and it is the only thing that repairs a Logto that was rebuilt
      // under a still-registered instance.
      const oidc = await provisionIssuer(deps, req.log, row, tenant, checked.urls, previous);

      req.log.info(
        {
          installationId: row.id,
          tenant: tenant.slug,
          moved,
          from: previous?.baseUrl ?? null,
          baseUrl: row.baseUrl,
          oidc: oidc === null ? 'none' : oidc.clientId,
        },
        moved ? 'installation reported a new address' : 'installation reported the same address',
      );
      return {
        installationId: row.id,
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        tenantName: tenant.name,
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
      //
      // `others` is not courtesy. The dashboard and the storefront are one shared client each, so
      // a blind set-difference here deletes a callback a DIFFERENT, still-serving installation
      // reported -- measured on a running stack: minting a throwaway installation at a live box's
      // dashboard address and deleting it took the live box's redirect URI with it.
      const others = (await listOtherInstallations(deps.db, row.id)).flatMap((other) => {
        const theirs = rowUrls(other);
        return theirs === null ? [] : [theirs];
      });
      const removed = await deps.identity.deprovision({
        applicationId: row.logtoApplicationId,
        urls: rowUrls(row),
        others,
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
