/**
 * The auth adapter interface (BUILD-PLAN §4.1). Behind an interface from day one so the Identity
 * phase swaps an implementation rather than editing every route.
 *
 * No route handler ever sees an adapter: the Fastify plugin (task 03) calls verify(), decorates
 * request.principal and establishes tenant context.
 */

export interface StaffPrincipal {
  readonly kind: 'staff';
  /** Stable subject from the issuer. */
  readonly subject: string;
  /**
   * BC1: a staff token is scoped to exactly one tenant, never a list of memberships. Switching
   * tenants mints a new token; it does not widen this one.
   */
  readonly tenantId: string;
  readonly roles: readonly StaffRole[];
  /** Epoch seconds. */
  readonly expiresAt: number;
}

export type StaffRole = 'owner' | 'staff';

export interface ShopperPrincipal {
  readonly kind: 'shopper';
  readonly subject: string;
  /**
   * Deliberately tenant-less (BI2). The tenant comes from the route and the subject from the
   * token, and a shopper query applies both conditions -- never one without the other.
   */
  readonly tenantId: null;
  readonly expiresAt: number;
}

export type Principal = StaffPrincipal | ShopperPrincipal;

export type PrincipalAudience = 'staff' | 'shopper';

export interface AuthorizeUrlParams {
  readonly redirectUri: string;
  readonly audience: PrincipalAudience;
  /** Selects the organization for a staff login; ignored for shoppers. */
  readonly tenantSlug?: string;
  readonly state: string;
}

export interface ExchangeParams {
  readonly code: string;
  readonly redirectUri: string;
}

export interface ExchangeResult {
  readonly principal: Principal;
  readonly accessToken: string;
  readonly refreshToken?: string;
}

export interface TokenForTenantParams {
  readonly refreshToken: string;
  readonly tenantId: string;
}

export interface TokenForTenantResult {
  readonly principal: StaffPrincipal;
  readonly accessToken: string;
}

export interface AuthAdapter {
  readonly name: 'stub' | 'oidc';

  /**
   * Verify a bearer token with no network call -- cached keys only. A dedicated instance must be
   * able to do this while the control plane is down (CG1).
   *
   * Returns null for an absent, malformed, expired or badly-signed token. It never throws for a
   * bad token; it throws only when the adapter itself is broken.
   */
  verify(token: string): Promise<Principal | null>;

  /** Where to send the browser to start an interactive login. */
  authorizeUrl(params: AuthorizeUrlParams): Promise<string>;

  /** Exchange an authorization code. Needs the issuer to be reachable. */
  exchange(params: ExchangeParams): Promise<ExchangeResult>;

  /** Mint a tenant-scoped staff token (BC1). Switching tenants calls this, not a wider token. */
  tokenForTenant(params: TokenForTenantParams): Promise<TokenForTenantResult>;

  /** Feeds the degradation state machine (CG1, CG3). Must not throw. */
  issuerReachable(): Promise<boolean>;
}
