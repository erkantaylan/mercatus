/**
 * The control plane's three credentials. Not one of them is a tenant-scoped staff token, and that
 * is deliberate (BH1): the platform console is a different app with a different audience, so a
 * merchant's token can never reach an operator endpoint by carrying a flag.
 *
 *   operator   the console. A short HS256 token, `aud: "operator"`, minted by /dev/login/operator
 *              while the adapter is the stub and by the IdP once the Identity phase lands.
 *   instance   a registered dedicated data plane. An opaque random string, stored only as a
 *              sha256 hash, per instance and individually revocable (CE1).
 *   bootstrap  a one-time registration token, in the BODY of /installations/register, hashed the
 *              same way and burned on first use.
 *
 * Every failure below returns ONE generic code and logs which check actually failed (S1). An
 * endpoint that says "unknown installation" rather than "not authenticated" is an oracle.
 */
import { ForbiddenError, UnauthenticatedError } from '@mercatus/core';
import { findInstallationByInstanceHash, hashToken } from '@mercatus/db-platform';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { JWTPayload } from 'jose';
import { jwtVerify, SignJWT } from 'jose';

import type { PlatformDeps } from './deps.js';

export const OPERATOR_ISSUER = 'mercatus-platform-stub';
export const OPERATOR_AUDIENCE = 'operator';

export interface OperatorPrincipal {
  readonly kind: 'operator';
  readonly subject: string;
  readonly expiresAt: number;
}

export interface InstancePrincipal {
  readonly kind: 'instance';
  readonly installationId: string;
  readonly tenantId: string;
}

export type PlatformPrincipal = OperatorPrincipal | InstancePrincipal;

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the guards below. Null on public routes -- /health, /signup, the callback. */
    platformPrincipal: PlatformPrincipal | null;
  }
}

export function decoratePlatformPrincipal(app: FastifyInstance): void {
  app.decorateRequest('platformPrincipal', null);
}

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return null;
  const token = rest.join(' ').trim();
  return token.length > 0 ? token : null;
}

export function issueOperatorToken(
  secret: string,
  params: { subject: string; ttlSeconds?: number },
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(OPERATOR_ISSUER)
    .setAudience(OPERATOR_AUDIENCE)
    .setSubject(params.subject)
    .setIssuedAt()
    .setExpirationTime(`${String(params.ttlSeconds ?? 3600)}s`)
    .sign(new TextEncoder().encode(secret));
}

async function verifyOperatorToken(
  secret: string,
  token: string,
): Promise<OperatorPrincipal | null> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: OPERATOR_ISSUER,
      audience: OPERATOR_AUDIENCE,
      algorithms: ['HS256'],
    }));
  } catch {
    return null;
  }
  const subject = payload.sub;
  if (!subject || typeof payload.exp !== 'number') return null;
  return { kind: 'operator', subject, expiresAt: payload.exp };
}

async function verifyInstanceToken(
  deps: PlatformDeps,
  token: string,
): Promise<InstancePrincipal | null> {
  // The token itself is never stored, so a dump of `installations` yields nothing usable.
  const row = await findInstallationByInstanceHash(deps.db, hashToken(token));
  if (!row?.instanceTokenHash) return null;
  return { kind: 'instance', installationId: row.id, tenantId: row.tenantId };
}

/** The console's guard. */
export function requireOperator(deps: PlatformDeps): preHandlerHookHandler {
  return async function operatorGuard(req) {
    const token = bearer(req);
    if (!token) {
      throw new UnauthenticatedError(undefined, {
        logDetail: 'no bearer token on an operator route',
      });
    }
    const secret = deps.config.authStubSecret;
    const principal = secret ? await verifyOperatorToken(secret, token) : null;
    if (!principal) {
      throw new UnauthenticatedError(undefined, {
        logDetail: 'bearer token is not an operator token (wrong audience, expired or forged)',
      });
    }
    req.platformPrincipal = principal;
  };
}

/** A registered dedicated instance, reporting in (CE4: it calls us; we never call it). */
export function requireInstance(deps: PlatformDeps): preHandlerHookHandler {
  return async function instanceGuard(req) {
    const token = bearer(req);
    if (!token) {
      throw new UnauthenticatedError(undefined, {
        logDetail: 'no bearer token on an instance route',
      });
    }
    const principal = await verifyInstanceToken(deps, token);
    if (!principal) {
      throw new UnauthenticatedError(undefined, {
        logDetail: 'bearer token matches no registered installation (revoked, or never issued)',
      });
    }
    req.platformPrincipal = principal;
  };
}

/**
 * The licence endpoints answer both the console and the box the licence belongs to. Which one is
 * asking still matters: an instance may read ITS tenant and no other, which `assertMayReadTenant`
 * below enforces at the point of use.
 */
export function requireOperatorOrInstance(deps: PlatformDeps): preHandlerHookHandler {
  return async function eitherGuard(req) {
    const token = bearer(req);
    if (!token) {
      throw new UnauthenticatedError(undefined, { logDetail: 'no bearer token on a licence route' });
    }
    const secret = deps.config.authStubSecret;
    const operator = secret ? await verifyOperatorToken(secret, token) : null;
    const principal = operator ?? (await verifyInstanceToken(deps, token));
    if (!principal) {
      throw new UnauthenticatedError(undefined, {
        logDetail: 'bearer token is neither an operator token nor a live instance token',
      });
    }
    req.platformPrincipal = principal;
  };
}

/**
 * An instance token names exactly one tenant, so a box asking about another tenant's licence is a
 * refusal rather than a widening -- the same rule as BI1, arriving through a credential instead
 * of a route. An operator may read any tenant; that is what the console is for, and BH2 is why it
 * is logged.
 */
export function assertMayReadTenant(req: FastifyRequest, tenantId: string): void {
  const principal = req.platformPrincipal;
  if (!principal) throw new UnauthenticatedError();
  if (principal.kind === 'instance' && principal.tenantId !== tenantId) {
    throw new ForbiddenError(undefined, {
      logDetail: `installation ${principal.installationId} is registered to ${principal.tenantId}, not ${tenantId}`,
    });
  }
  if (principal.kind === 'operator') {
    req.log.info(
      { operator: principal.subject, tenantId, route: req.url },
      'operator read a tenant (BH2)',
    );
  }
}
