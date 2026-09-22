/**
 * The store's OWN session cookie.
 *
 * This is load-bearing, not an optimisation (README Q20). A dedicated instance verifies existing
 * tokens offline against cached JWKS, but it cannot MINT new ones -- only the control plane can.
 * So the store performs the OIDC login once, and from then on the browser presents a cookie this
 * process signed and this process verifies. During a control-plane outage every signed-in shopper
 * and staff member keeps working; only a first-ever sign-in to that store fails (CG1).
 *
 * The claim shape is deliberately identical to the stub adapter's, so `toPrincipal` is the one
 * place a set of claims becomes a Principal -- for a stub token, a Logto organization token and a
 * session cookie alike. Only the issuer and the key differ.
 *
 *     { iss: "mercatus-session", aud: "staff" | "shopper", sub, tid?, roles?, iat, exp }
 *
 * The cookie is HttpOnly (no script reads it), SameSite=Lax (it must survive the redirect back
 * from the IdP, which SameSite=Strict would drop) and Secure outside development.
 */
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

import { toPrincipal } from './stub-adapter.js';
import type { Principal } from './types.js';

export const SESSION_COOKIE_NAME = 'mercatus_session';
export const SESSION_ISSUER = 'mercatus-session';

/** jose refuses an HS256 key shorter than the digest. Fail at construction, not at first login. */
const MIN_SECRET_LENGTH = 32;

export interface SessionIssuerOptions {
  /** SESSION_SECRET. At least 32 characters. */
  readonly secret: string;
  /** Default 43200 (12 hours). Long on purpose: it is what survives an outage. */
  readonly ttlSeconds?: number;
  /** Adds `Secure` to the cookie. Default: true unless nodeEnv is 'development'. */
  readonly secureCookie?: boolean;
  readonly cookieName?: string;
}

/** A cookie header value, parsed. Returns undefined rather than throwing on anything malformed. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * Issues and verifies the session cookie. Nothing here talks to an issuer; that is the whole
 * point -- this is the half of authentication that keeps working when the control plane does not.
 */
export class SessionIssuer {
  readonly #key: Uint8Array;
  readonly #ttl: number;
  readonly #secure: boolean;
  readonly cookieName: string;

  constructor(options: SessionIssuerOptions) {
    if (options.secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters; jose requires a ` +
          '256-bit key for HS256.',
      );
    }
    this.#key = new TextEncoder().encode(options.secret);
    this.#ttl = options.ttlSeconds ?? 43_200;
    this.#secure = options.secureCookie ?? true;
    this.cookieName = options.cookieName ?? SESSION_COOKIE_NAME;
  }

  get ttlSeconds(): number {
    return this.#ttl;
  }

  /** The session for a principal the adapter has just authenticated. */
  issue(principal: Principal): Promise<string> {
    const claims: JWTPayload =
      principal.kind === 'staff'
        ? { tid: principal.tenantId, roles: [...principal.roles] }
        : // BI2: a shopper session names no tenant, exactly as a shopper token does not. The
          // tenant comes from the route on every request and the subject from here.
          {};
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(SESSION_ISSUER)
      .setAudience(principal.kind)
      .setSubject(principal.subject)
      .setIssuedAt()
      .setExpirationTime(`${this.#ttl}s`)
      .sign(this.#key);
  }

  /** Null for absent, malformed, expired or badly-signed. Never throws for a bad cookie (S1). */
  async verify(token: string | undefined): Promise<Principal | null> {
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.#key, {
        issuer: SESSION_ISSUER,
        algorithms: ['HS256'],
      });
      return toPrincipal(payload);
    } catch {
      return null;
    }
  }

  /** The cookie for a freshly issued session. */
  cookie(token: string): string {
    return this.#serialize(token, this.#ttl);
  }

  /** The cookie that ends a session. Same attributes, empty value, expired. */
  clearCookie(): string {
    return this.#serialize('', 0);
  }

  #serialize(value: string, maxAge: number): string {
    const parts = [
      `${this.cookieName}=${encodeURIComponent(value)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAge}`,
    ];
    if (this.#secure) parts.push('Secure');
    return parts.join('; ');
  }
}
