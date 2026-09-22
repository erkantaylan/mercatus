/**
 * StubAuthAdapter -- a real, working local issuer (BUILD-PLAN §4.2). It carries tasks 01-10; the
 * Identity phase (task 12) adds the Logto-backed oidc adapter behind the same interface.
 *
 * The token shape, which the oidc adapter must also produce, is HS256-signed JWT with:
 *
 *     { iss: "mercatus-stub", aud: "staff" | "shopper" | "refresh",
 *       sub: <subject>, tid: <tenant uuid | absent>, roles: ["owner"|"staff"], iat, exp }
 *
 * - `aud` is the audience split of BH1: a staff token and a shopper token are different tokens,
 *   not one token with a flag.
 * - `tid` is present on staff tokens only. A shopper token carrying `tid` is rejected outright,
 *   because the whole of BI2 rests on a shopper's tenant coming from the route.
 * - `roles` is present on staff tokens only.
 */
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

import { ValidationError, TenantNotFoundError } from '../errors.js';
import type {
  AuthAdapter,
  AuthorizeUrlParams,
  ExchangeParams,
  ExchangeResult,
  Principal,
  StaffPrincipal,
  StaffRole,
  TokenForTenantParams,
  TokenForTenantResult,
} from './types.js';

export const STUB_ISSUER = 'mercatus-stub';

/** jose refuses an HS256 key shorter than the digest. Fail at construction, not at first login. */
const MIN_SECRET_LENGTH = 32;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StubAuthAdapterOptions {
  /** AUTH_STUB_SECRET. At least 32 characters. */
  readonly secret: string;
  readonly issuer?: string;
  /** Default 900 (15 minutes), matching the access-token lifetime in architecture.md §4. */
  readonly accessTokenTtlSeconds?: number;
  /** Default 86400. The refresh session is tenant-less (BC1). */
  readonly refreshTokenTtlSeconds?: number;
  /** Where authorizeUrl() sends the browser. Default the store-api dev login page. */
  readonly devLoginUrl?: string;
  /**
   * slug -> tenant uuid. The stub cannot know the tenant table, so the app supplies the lookup.
   * Without it, exchange() accepts a uuid in the code and refuses a slug.
   */
  readonly resolveTenantId?: (slug: string) => Promise<string | null>;
  /** Defaults to process.env.NODE_ENV. Injectable so tests need not mutate the environment. */
  readonly nodeEnv?: string | undefined;
}

export interface IssueStaffTokenParams {
  readonly subject: string;
  readonly tenantId: string;
  readonly roles?: readonly StaffRole[];
  readonly ttlSeconds?: number;
}

export interface IssueShopperTokenParams {
  readonly subject: string;
  readonly ttlSeconds?: number;
}

export class StubAuthAdapter implements AuthAdapter {
  readonly name = 'stub' as const;

  readonly #key: Uint8Array;
  readonly #issuer: string;
  readonly #accessTtl: number;
  readonly #refreshTtl: number;
  readonly #devLoginUrl: string;
  readonly #resolveTenantId: ((slug: string) => Promise<string | null>) | undefined;

  constructor(options: StubAuthAdapterOptions) {
    const nodeEnv = options.nodeEnv ?? process.env['NODE_ENV'];
    if (nodeEnv === 'production') {
      // A stub issuer in production is a forged-token generator. Refuse to exist.
      throw new Error(
        'StubAuthAdapter refuses to construct with NODE_ENV=production. Set AUTH_ADAPTER=oidc.',
      );
    }
    if (options.secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `AUTH_STUB_SECRET must be at least ${MIN_SECRET_LENGTH} characters; jose requires a ` +
          '256-bit key for HS256.',
      );
    }
    this.#key = new TextEncoder().encode(options.secret);
    this.#issuer = options.issuer ?? STUB_ISSUER;
    this.#accessTtl = options.accessTokenTtlSeconds ?? 900;
    this.#refreshTtl = options.refreshTokenTtlSeconds ?? 86_400;
    this.#devLoginUrl = options.devLoginUrl ?? 'http://localhost:4002/dev/login';
    this.#resolveTenantId = options.resolveTenantId;
  }

  async verify(token: string): Promise<Principal | null> {
    if (!token) return null;
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.#key, {
        issuer: this.#issuer,
        algorithms: ['HS256'],
      }));
    } catch {
      // Absent, malformed, expired, wrong issuer, bad signature -- all the same answer, and the
      // caller gets one generic failure out of it (S1).
      return null;
    }
    return toPrincipal(payload);
  }

  authorizeUrl(params: AuthorizeUrlParams): Promise<string> {
    const url = new URL(this.#devLoginUrl);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('audience', params.audience);
    url.searchParams.set('state', params.state);
    if (params.audience === 'staff' && params.tenantSlug !== undefined) {
      url.searchParams.set('tenant_slug', params.tenantSlug);
    }
    return Promise.resolve(url.toString());
  }

  /**
   * Accepts `stub:staff:<subject>:<tenantSlugOrUuid>` and `stub:shopper:<subject>`.
   * The redirect uri is not checked -- there is no registered client to check it against.
   *
   * THE SUBJECT IS PERCENT-ENCODED. Both of this repo's stub subjects contain a colon
   * (`dev-staff:acme`, `dev-shopper:+905550000001`), which a naive `split(':')` silently truncates
   * to `dev-staff` -- so the first real sign-in through the stub's own authorization page signed
   * everybody in as the same person. Decoding is a no-op for a subject that needs no escaping, so
   * a hand-written `stub:staff:user-1:<uuid>` still means exactly what it says.
   */
  async exchange(params: ExchangeParams): Promise<ExchangeResult> {
    const parts = params.code.split(':');
    const [prefix, kind, rawSubject, tenantRef] = parts;
    if (prefix !== 'stub' || !rawSubject) {
      throw new ValidationError('Stub authorization codes look like stub:<kind>:<subject>[:<tenant>].');
    }
    let subject: string;
    try {
      subject = decodeURIComponent(rawSubject);
    } catch {
      throw new ValidationError('The subject in that stub code is not decodable.');
    }

    if (kind === 'shopper') {
      const principal = shopperPrincipal(subject, this.#accessTtl);
      return {
        principal,
        accessToken: await this.issueShopperToken({ subject }),
        refreshToken: await this.#issueRefreshToken(subject, undefined),
      };
    }

    if (kind === 'staff') {
      if (!tenantRef) throw new ValidationError('A staff code must name a tenant.');
      const tenantId = await this.#tenantIdFor(tenantRef);
      const roles: readonly StaffRole[] = ['owner'];
      return {
        principal: staffPrincipal(subject, tenantId, roles, this.#accessTtl),
        accessToken: await this.issueStaffToken({ subject, tenantId, roles }),
        refreshToken: await this.#issueRefreshToken(subject, roles),
      };
    }

    throw new ValidationError(`Unknown stub principal kind "${kind ?? ''}".`);
  }

  /** BC1: a new tenant-scoped token, not a wider one. */
  async tokenForTenant(params: TokenForTenantParams): Promise<TokenForTenantResult> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(params.refreshToken, this.#key, {
        issuer: this.#issuer,
        audience: 'refresh',
        algorithms: ['HS256'],
      }));
    } catch {
      throw new ValidationError('The refresh session is not valid.');
    }
    const subject = payload.sub;
    if (!subject) throw new ValidationError('The refresh session has no subject.');
    const roles = readRoles(payload['roles']) ?? (['owner'] as const);
    return {
      principal: staffPrincipal(subject, params.tenantId, roles, this.#accessTtl),
      accessToken: await this.issueStaffToken({ subject, tenantId: params.tenantId, roles }),
    };
  }

  /** The stub is the issuer, and it is in-process. */
  issuerReachable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  // -- beyond the interface: what POST /dev/login calls (BUILD-PLAN §6.2) ---------------------

  issueStaffToken(params: IssueStaffTokenParams): Promise<string> {
    const roles = params.roles ?? (['owner'] as const);
    return this.#sign('staff', params.subject, params.ttlSeconds ?? this.#accessTtl, {
      tid: params.tenantId,
      roles: [...roles],
    });
  }

  issueShopperToken(params: IssueShopperTokenParams): Promise<string> {
    // No tid. A shopper token that names a tenant is rejected on verify (BI2).
    return this.#sign('shopper', params.subject, params.ttlSeconds ?? this.#accessTtl, {});
  }

  #issueRefreshToken(subject: string, roles: readonly StaffRole[] | undefined): Promise<string> {
    return this.#sign('refresh', subject, this.#refreshTtl, roles ? { roles: [...roles] } : {});
  }

  async #tenantIdFor(ref: string): Promise<string> {
    if (UUID_RE.test(ref)) return ref;
    const resolved = await this.#resolveTenantId?.(ref);
    if (!resolved) {
      throw new TenantNotFoundError(
        `Cannot turn "${ref}" into a tenant id; pass a uuid or give the adapter a resolveTenantId.`,
      );
    }
    return resolved;
  }

  #sign(
    audience: 'staff' | 'shopper' | 'refresh',
    subject: string,
    ttlSeconds: number,
    claims: JWTPayload,
  ): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(this.#issuer)
      .setAudience(audience)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(this.#key);
  }
}

function staffPrincipal(
  subject: string,
  tenantId: string,
  roles: readonly StaffRole[],
  ttlSeconds: number,
): StaffPrincipal {
  return {
    kind: 'staff',
    subject,
    tenantId,
    roles,
    expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
}

function shopperPrincipal(subject: string, ttlSeconds: number): Principal {
  return {
    kind: 'shopper',
    subject,
    tenantId: null,
    expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
}

function readRoles(value: unknown): readonly StaffRole[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const roles: StaffRole[] = [];
  for (const entry of value) {
    if (entry !== 'owner' && entry !== 'staff') return null;
    roles.push(entry);
  }
  return roles;
}

/** Claims -> Principal, or null. Exported so the oidc adapter reuses exactly these checks. */
export function toPrincipal(payload: JWTPayload): Principal | null {
  const subject = payload.sub;
  const expiresAt = payload.exp;
  if (!subject || typeof expiresAt !== 'number') return null;

  if (payload.aud === 'staff') {
    const tenantId = payload['tid'];
    if (typeof tenantId !== 'string' || tenantId.length === 0) return null;
    const roles = readRoles(payload['roles']);
    if (!roles) return null;
    return { kind: 'staff', subject, tenantId, roles, expiresAt };
  }

  if (payload.aud === 'shopper') {
    // BI2: a tenant-scoped shopper token is not a thing. If one turns up, it is a forgery or a
    // bug in an issuer, and either way it does not get to be a principal.
    if (payload['tid'] != null) return null;
    return { kind: 'shopper', subject, tenantId: null, expiresAt };
  }

  // 'refresh' is not a principal. It buys an access token and nothing else.
  return null;
}
