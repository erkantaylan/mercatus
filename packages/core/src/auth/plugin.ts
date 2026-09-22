/**
 * The auth and tenancy hook (BUILD-PLAN §4.4).
 *
 * NO ROUTE HANDLER EVER SEES THE ADAPTER. This is the one place a token is verified, and the one
 * place a tenant is decided, so the BI1/BI2 split is a property of the request pipeline rather
 * than something thirty handlers each have to remember:
 *
 *   staff    tenant from the TOKEN. A host or path that disagrees is 403, never a switch (BI1).
 *   shopper  token is deliberately tenant-less. Tenant from the route, subject from the token,
 *            and both conditions always applied downstream (BI2).
 *   public   tenant from the route, no subject.
 *
 * The context this produces is a TenantContext, not a tenant id in a variable: withTenantTx reads
 * it through AsyncLocalStorage, so a query cannot be issued with "some tenant" by accident (BE1).
 */
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';

import {
  ForbiddenError,
  MissingTenantContextError,
  TenantMismatchError,
  TenantNotFoundError,
  UnauthenticatedError,
} from '../errors.js';
import type { TenantContext } from '../tenant/context.js';
import type { TenantResolutionConfig } from '../tenant/resolve.js';
import { tenantCandidates } from '../tenant/resolve.js';
import { readCookie, type SessionIssuer } from './session.js';
import type { AuthAdapter, Principal, StaffRole } from './types.js';

/** What a tenant lookup returns. The id is the uuid; the slug is what appears in URLs (BV3). */
export interface TenantRef {
  readonly id: string;
  readonly slug: string;
}

/**
 * Supplied by the app, because core cannot reach a database: the data plane reads `tenants`, the
 * control plane reads its own table, and neither belongs in here.
 */
export interface TenantDirectory {
  bySlug(slug: string): Promise<TenantRef | null>;
  byId(id: string): Promise<TenantRef | null>;
}

export interface AuthContextOptions {
  readonly adapter: AuthAdapter;
  /** Omitted by a service with no tenants of its own (fake-bank). */
  readonly tenants?: TenantDirectory;
  readonly deployment?: TenantResolutionConfig;
  /**
   * The store's OWN session cookie, checked when there is no bearer token. It is what keeps a
   * dedicated instance serving signed-in people while the issuer is unreachable (README Q20) --
   * a cookie this process signed needs nobody's permission to verify.
   */
  readonly session?: SessionIssuer;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** null for an absent, malformed, expired or badly-signed token. Never a thrown error (S1). */
    principal: Principal | null;
    /** null when the request names no tenant -- /health, /docs. */
    tenantContext: TenantContext | null;
  }
}

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return null;
  const token = rest.join(' ').trim();
  return token.length > 0 ? token : null;
}

async function establishTenant(
  req: FastifyRequest,
  principal: Principal | null,
  tenants: TenantDirectory,
  deployment: TenantResolutionConfig,
): Promise<TenantContext | null> {
  const candidates = tenantCandidates({ hostname: req.hostname, url: req.url }, deployment);
  const winner = candidates[0] ?? null;

  if (principal?.kind === 'staff') {
    // BI1: the token names the tenant. The host and the path only select branding.
    const ref = await tenants.byId(principal.tenantId);
    if (!ref) {
      throw new ForbiddenError(undefined, {
        logDetail: `staff token names tenant ${principal.tenantId}, which this data plane does not serve`,
      });
    }
    if (winner && winner.slug !== ref.slug) {
      throw new TenantMismatchError(undefined, {
        logDetail: `token tenant ${ref.slug} vs ${winner.source} candidate ${winner.slug}`,
      });
    }
    return { tenantId: ref.id, slug: ref.slug, source: 'token', subject: principal.subject };
  }

  if (!winner) return null;

  // A pinned instance serves one tenant. Another slug in the URL is a refusal, not a switch: it
  // is the same failure BI1 describes, arriving through the deployment rather than a token.
  if (winner.source === 'deployment') {
    const disagreeing = candidates.find((c) => c.source !== 'deployment' && c.slug !== winner.slug);
    if (disagreeing) {
      throw new TenantMismatchError(undefined, {
        logDetail: `instance is pinned to ${winner.slug}; ${disagreeing.source} names ${disagreeing.slug}`,
      });
    }
  }

  const ref = await tenants.bySlug(winner.slug);
  if (!ref) throw new TenantNotFoundError();

  return {
    tenantId: ref.id,
    slug: ref.slug,
    source: winner.source === 'deployment' ? 'deployment' : 'route',
    // BI2: present for a shopper, absent for anonymous browsing. The subject half of every
    // shopper query comes from here and from nowhere else.
    ...(principal ? { subject: principal.subject } : {}),
  };
}

/**
 * Registers the hook on the instance itself rather than as an encapsulated plugin, so routes
 * registered afterwards -- in any scope -- see the decorators. It is twenty lines; wrapping it in
 * fastify-plugin to defeat encapsulation would be more machinery than the thing it carries.
 */
export function registerAuthContext(app: FastifyInstance, options: AuthContextOptions): void {
  app.decorateRequest('principal', null);
  app.decorateRequest('tenantContext', null);

  app.addHook('onRequest', async (req) => {
    const token = bearer(req.headers.authorization);
    req.principal = token ? await options.adapter.verify(token) : null;

    if (token && !req.principal && options.session) {
      // THE STORE'S OWN SESSION, PRESENTED AS A BEARER TOKEN (v2.0.0).
      //
      // It is the same credential as the cookie below, signed by this process and verified by
      // this process; only the transport differs. A browser front end on another origin cannot
      // be sent this store's host-only cookie, so without this the merchant dashboard would have
      // to fall back to a `/dev/login/*` route -- which is exactly the hole that made "real OIDC"
      // and "a shopping demo" mutually exclusive before this release.
      //
      // The adapter is asked FIRST, so an issuer-minted token still wins and nothing about the
      // trust boundary moves: a session we did not sign does not verify here either.
      req.principal = await options.session.verify(token);
    }

    if (token && !req.principal) {
      // S1: the client gets one generic failure from whichever route needs auth. The reason the
      // token did not verify is logged here and goes no further.
      req.log.debug({ route: req.url }, 'bearer token did not verify');
    }

    if (!req.principal && options.session) {
      // A bearer token wins when one is present, so a stale cookie can never quietly override an
      // explicit credential. Otherwise the session is the credential, and it is verified with a
      // key this process holds -- no issuer, no network, no control plane (CG1).
      const cookie = readCookie(req.headers.cookie, options.session.cookieName);
      req.principal = await options.session.verify(cookie);
      if (cookie && !req.principal) {
        req.log.debug({ route: req.url }, 'session cookie did not verify');
      }
    }

    if (options.tenants && options.deployment) {
      req.tenantContext = await establishTenant(req, req.principal, options.tenants, options.deployment);
    }
  });
}

/** The context, or a loud failure. Never "some tenant" (BE1). */
export function requireTenantContext(req: FastifyRequest): TenantContext {
  if (!req.tenantContext) throw new MissingTenantContextError();
  return req.tenantContext;
}

/**
 * preHandler for the staff surface. The tenant is already fixed to the token's by the hook above;
 * this only decides whether there is a staff principal at all, and whether it has the role.
 */
export function requireStaff(roles?: readonly StaffRole[]): preHandlerHookHandler {
  return function staffGuard(req, _reply, done) {
    const principal = req.principal;
    if (!principal) {
      done(new UnauthenticatedError(undefined, { logDetail: 'no bearer token on a staff route' }));
      return;
    }
    if (principal.kind !== 'staff') {
      done(new ForbiddenError(undefined, { logDetail: 'shopper token on a staff route (BH1)' }));
      return;
    }
    if (roles && roles.length > 0 && !principal.roles.some((r) => roles.includes(r))) {
      done(
        new ForbiddenError(undefined, {
          logDetail: `roles ${principal.roles.join(',')} do not include one of ${roles.join(',')}`,
        }),
      );
      return;
    }
    if (!req.tenantContext) {
      done(new MissingTenantContextError());
      return;
    }
    done();
  };
}

/** preHandler for the shopper surface. BI2's two halves are both required to be present. */
export function requireShopper(): preHandlerHookHandler {
  return function shopperGuard(req, _reply, done) {
    const principal = req.principal;
    if (!principal) {
      done(new UnauthenticatedError(undefined, { logDetail: 'no bearer token on a shopper route' }));
      return;
    }
    if (principal.kind !== 'shopper') {
      done(new ForbiddenError(undefined, { logDetail: 'staff token on a shopper route (BH1)' }));
      return;
    }
    if (!req.tenantContext) {
      // The route half of BI2. A shopper token carries no tenant, so without a route there is
      // nothing to scope to, and guessing is exactly what this rule forbids.
      done(new MissingTenantContextError());
      return;
    }
    done();
  };
}
