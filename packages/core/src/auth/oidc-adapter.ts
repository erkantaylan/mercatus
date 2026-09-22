/**
 * `LogtoAuthAdapter` -- the real issuer, behind the interface the stub has carried since task 01
 * (BUILD-PLAN §4.3). One issuer and one JWKS, never two (CD4).
 *
 * The whole design pressure on this file is a single sentence: A DEDICATED INSTANCE MUST VERIFY A
 * TOKEN WITH THE CONTROL PLANE DOWN. So:
 *
 *   - `verify()` makes NO network call, ever. It reads a JWKS that was cached on disk the last
 *     time the issuer was reachable. A key rotation we have not seen yet is the one case that
 *     needs the network, and even then a failure to reach it is a rejected token, not a crash.
 *   - everything the adapter learns while online -- the discovery document, the key set, and
 *     which Logto organization is which tenant -- is written to ONE cache file beside it.
 *   - `exchange()` is the only operation that genuinely requires the issuer, which is why the
 *     store issues its own session cookie immediately afterwards (see session.ts). First-ever
 *     sign-in is the only thing an outage takes away.
 *
 * Token shapes, as Logto 1.43 actually emits them (verified, lessons/08-identity-logto.md):
 *
 *   organization token   aud = "urn:logto:organization:<orgId>", ES384, sub = user id
 *   id token             aud = <clientId>, carries `organizations` and `organization_roles`
 *                        (the latter as "<orgId>:<roleName>")
 *   access token         OPAQUE unless a resource is requested -- never assume it is a JWT
 *
 * An organization token names an organization, not a tenant, and it carries no role claim. Both
 * gaps are closed from the cache, which the adapter fills at `exchange()` time from the id token
 * and the userinfo endpoint. Offline, an organization nobody has ever signed in to is unknown and
 * its token does not verify -- the documented degradation, not a surprise.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createLocalJWKSet, decodeJwt, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';

import { ValidationError } from '../errors.js';
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

const ORGANIZATION_AUDIENCE_PREFIX = 'urn:logto:organization:';

/** Logto's organization scopes. Requested on a staff login; absent on a shopper's (CD3). */
const STAFF_SCOPES = [
  'openid',
  'offline_access',
  'profile',
  'urn:logto:scope:organizations',
  'urn:logto:scope:organization_roles',
] as const;
const SHOPPER_SCOPES = ['openid', 'offline_access', 'profile'] as const;

export interface LogtoAuthAdapterOptions {
  /** OIDC_ISSUER, e.g. http://127.0.0.1:3011/oidc. The `iss` claim on every token. */
  readonly issuer: string;
  /**
   * OIDC_CLIENT_ID / OIDC_CLIENT_SECRET. BOTH ARE OPTIONAL, because an instance is registered
   * with the issuer by the bootstrap rather than configured by hand: the registration lands in
   * the same cache file as the keys, and the instance PULLS it (CE4, CE7). Env wins when set.
   */
  readonly clientId?: string;
  readonly clientSecret?: string;
  /** OIDC_JWKS_CACHE_PATH. One JSON file: discovery + keys + the organization directory. */
  readonly cachePath: string;
  /**
   * slug -> tenant uuid. The adapter must not know the tenants table, and a Logto organization
   * id is NOT a tenant id (BV1) -- the organization's name is the slug, and the slug is what the
   * data plane already knows how to resolve.
   */
  readonly resolveTenantIdBySlug?: (slug: string) => Promise<string | null>;
  /** Default 3000. Every network call is bounded; none of them may hang a request. */
  readonly fetchTimeoutMs?: number;
}

/** What survives a restart with the control plane down. */
interface IdentityCache {
  /** Written by the identity bootstrap: this instance's registration with the issuer. */
  client?: { clientId: string; clientSecret: string };
  discovery?: {
    authorization_endpoint: string;
    token_endpoint: string;
    jwks_uri: string;
    userinfo_endpoint: string;
  };
  jwks?: JSONWebKeySet;
  /** Logto organization id -> what this data plane needs to know about it. */
  organizations?: Record<string, { slug: string; roles?: Record<string, StaffRole[]> }>;
}

interface TokenResponse {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

function readRoles(value: unknown): StaffRole[] {
  if (!Array.isArray(value)) return [];
  const roles: StaffRole[] = [];
  for (const entry of value) {
    if (entry === 'owner' || entry === 'staff') roles.push(entry);
  }
  return roles;
}

/** "<orgId>:<roleName>" -> the roles for one organization. Logto's own spelling. */
function rolesForOrganization(claim: unknown, organizationId: string): StaffRole[] {
  if (!Array.isArray(claim)) return [];
  const prefix = `${organizationId}:`;
  return readRoles(
    claim
      .filter((e): e is string => typeof e === 'string' && e.startsWith(prefix))
      .map((e) => e.slice(prefix.length)),
  );
}

export class LogtoAuthAdapter implements AuthAdapter {
  readonly name = 'oidc' as const;

  readonly #issuer: string;
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #cachePath: string;
  readonly #timeout: number;
  readonly #resolveTenantIdBySlug: ((slug: string) => Promise<string | null>) | undefined;
  #cache: IdentityCache;

  constructor(options: LogtoAuthAdapterOptions) {
    this.#issuer = options.issuer.replace(/\/$/, '');
    this.#cachePath = options.cachePath;
    this.#timeout = options.fetchTimeoutMs ?? 3000;
    this.#resolveTenantIdBySlug = options.resolveTenantIdBySlug;
    this.#cache = this.#readCache();
    // Env wins; the pulled registration is the fallback. An instance with neither can still
    // VERIFY (that is the cached key set's job) -- it just cannot start an interactive login,
    // which `authorizeUrl` and `exchange` then say plainly rather than 500ing.
    this.#clientId = options.clientId ?? this.#cache.client?.clientId ?? '';
    this.#clientSecret = options.clientSecret ?? this.#cache.client?.clientSecret ?? '';
  }

  // -- cache -----------------------------------------------------------------------------------

  #readCache(): IdentityCache {
    try {
      return JSON.parse(readFileSync(this.#cachePath, 'utf8')) as IdentityCache;
    } catch {
      // No cache yet, or an unreadable one. An empty cache is a cold start, not an error: the
      // first reachable moment fills it.
      return {};
    }
  }

  #writeCache(): void {
    try {
      mkdirSync(dirname(this.#cachePath), { recursive: true });
      const temp = join(dirname(this.#cachePath), `.${Date.now()}.tmp`);
      writeFileSync(temp, JSON.stringify(this.#cache, null, 2), 'utf8');
      // Rename, so a crash mid-write cannot leave half a key set where a whole one was.
      renameSync(temp, this.#cachePath);
    } catch {
      // A read-only disk costs the offline guarantee on the NEXT restart, not this request.
    }
  }

  /** Snapshot of the organization directory. Exposed so a bootstrap can pre-seed it. */
  knownOrganizations(): Readonly<Record<string, { slug: string }>> {
    return this.#cache.organizations ?? {};
  }

  // -- network, all of it optional and all of it bounded ----------------------------------------

  async #fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(this.#timeout) });
    const body = (await response.json()) as T & { error?: string; error_description?: string };
    if (!response.ok) {
      throw new ValidationError(
        `${url} answered ${String(response.status)}: ${body.error ?? ''} ${body.error_description ?? ''}`.trim(),
      );
    }
    return body;
  }

  async #discovery(): Promise<NonNullable<IdentityCache['discovery']>> {
    const cached = this.#cache.discovery;
    if (cached) return cached;
    const document = await this.#fetchJson<NonNullable<IdentityCache['discovery']>>(
      `${this.#issuer}/.well-known/openid-configuration`,
    );
    this.#cache.discovery = document;
    this.#writeCache();
    return document;
  }

  /** Fetches the key set and caches it. Called when online; never on the verify path. */
  async refreshKeys(): Promise<void> {
    const { jwks_uri } = await this.#discovery();
    this.#cache.jwks = await this.#fetchJson<JSONWebKeySet>(jwks_uri);
    this.#writeCache();
  }

  // -- the interface ----------------------------------------------------------------------------

  /**
   * NO NETWORK. The cached key set is the whole of it, which is what makes a store on someone
   * else's server able to answer a request while we are down (CG1).
   */
  async verify(token: string): Promise<Principal | null> {
    if (!token) return null;
    const jwks = this.#cache.jwks;
    if (!jwks) return null;

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, createLocalJWKSet(jwks), { issuer: this.#issuer }));
    } catch {
      // Absent, malformed, expired, wrong issuer, bad signature, or signed by a key rotated in
      // since we last cached -- one answer for all of them, and the reason is logged by the hook.
      return null;
    }
    return this.#toPrincipal(payload);
  }

  async #toPrincipal(payload: JWTPayload): Promise<Principal | null> {
    const subject = payload.sub;
    const expiresAt = payload.exp;
    if (!subject || typeof expiresAt !== 'number') return null;

    const audience = typeof payload.aud === 'string' ? payload.aud : null;
    if (!audience?.startsWith(ORGANIZATION_AUDIENCE_PREFIX)) {
      // Anything that is not an organization token is not a staff principal. A shopper never
      // presents a Logto bearer to the store: they sign in once and carry the store's own session
      // cookie from then on (README Q20), which is the mechanism that survives an outage.
      return null;
    }

    const organizationId = audience.slice(ORGANIZATION_AUDIENCE_PREFIX.length);
    const entry = this.#cache.organizations?.[organizationId];
    if (!entry) return null;

    const tenantId = await this.#resolveTenantIdBySlug?.(entry.slug);
    if (!tenantId) return null;

    // Logto's organization token carries no role claim, so the roles are the ones cached when
    // this subject last signed in. Unknown means the LEAST privilege, never the most.
    const roles = entry.roles?.[subject];
    return {
      kind: 'staff',
      subject,
      tenantId,
      roles: roles && roles.length > 0 ? roles : (['staff'] as const),
      expiresAt,
    };
  }

  #requireRegistration(): void {
    if (!this.#clientId || !this.#clientSecret) {
      throw new ValidationError(
        'This instance is not registered with the issuer: set OIDC_CLIENT_ID and ' +
          'OIDC_CLIENT_SECRET, or run the identity bootstrap so the registration is pulled.',
      );
    }
  }

  async authorizeUrl(params: AuthorizeUrlParams): Promise<string> {
    this.#requireRegistration();
    const { authorization_endpoint } = await this.#discovery();
    const url = new URL(authorization_endpoint);
    url.searchParams.set('client_id', this.#clientId);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', params.state);
    url.searchParams.set(
      'scope',
      (params.audience === 'staff' ? STAFF_SCOPES : SHOPPER_SCOPES).join(' '),
    );
    // `offline_access` in the scope is NOT enough: Logto issues a refresh token only when the
    // authorization request also asks for consent. Without this the code exchange succeeds and
    // then there is no refresh token to mint the tenant-scoped organization token with, which
    // reads like a scope bug and is not one.
    url.searchParams.set('prompt', 'consent');
    // DV: the login page stays neutral. `organization_id` would select per-organization branding
    // and is deliberately not sent.
    return url.toString();
  }

  async exchange(params: ExchangeParams): Promise<ExchangeResult> {
    this.#requireRegistration();
    const { token_endpoint, userinfo_endpoint } = await this.#discovery();
    // The key set is refreshed here rather than on the verify path: this is the one operation
    // that already needs the issuer, so it is the right moment to pay for a rotation.
    await this.refreshKeys();

    const tokens = await this.#token(token_endpoint, {
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
    });

    const idToken = tokens.id_token;
    if (!idToken) throw new ValidationError('The issuer returned no id_token.');
    const jwks = this.#cache.jwks;
    if (!jwks) throw new ValidationError('No key set to verify the id_token against.');
    const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks), {
      issuer: this.#issuer,
      audience: this.#clientId,
    });

    const subject = payload.sub;
    if (!subject) throw new ValidationError('The id_token has no subject.');
    const organizations = Array.isArray(payload['organizations'])
      ? payload['organizations'].filter((o): o is string => typeof o === 'string')
      : [];

    if (organizations.length === 0) {
      // CD3: no organization membership means a shopper. Tenant-less, always (BI2).
      const expiresAt = typeof payload.exp === 'number' ? payload.exp : nowPlus(900);
      const result: ExchangeResult = {
        principal: { kind: 'shopper', subject, tenantId: null, expiresAt },
        accessToken: tokens.access_token ?? idToken,
        ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }),
      };
      return result;
    }

    // Staff. Learn every organization this person belongs to -- the directory is what makes an
    // organization token verifiable offline later -- then scope the token to one of them (BC1).
    await this.#learnOrganizations(userinfo_endpoint, tokens.access_token, payload, subject);

    const organizationId = organizations[0];
    if (!organizationId) throw new ValidationError('The id_token names no organization.');
    const refreshToken = tokens.refresh_token;
    if (!refreshToken) {
      throw new ValidationError('A staff login needs offline_access; the issuer returned no refresh token.');
    }

    const scoped = await this.#organizationToken(token_endpoint, refreshToken, organizationId);
    return {
      principal: scoped.principal,
      accessToken: scoped.accessToken,
      refreshToken: scoped.refreshToken ?? refreshToken,
    };
  }

  /** BC1: a new tenant-scoped token, never a wider one. */
  async tokenForTenant(params: TokenForTenantParams): Promise<TokenForTenantResult> {
    const { token_endpoint } = await this.#discovery();
    const organizationId = await this.#organizationFor(params.tenantId);
    if (!organizationId) {
      throw new ValidationError(`No Logto organization is known for tenant ${params.tenantId}.`);
    }
    const scoped = await this.#organizationToken(token_endpoint, params.refreshToken, organizationId);
    return { principal: scoped.principal, accessToken: scoped.accessToken };
  }

  /** Must not throw: it feeds the degradation state machine (CG1, CG3). */
  async issuerReachable(): Promise<boolean> {
    try {
      await this.#fetchJson(`${this.#issuer}/.well-known/openid-configuration`);
      return true;
    } catch {
      return false;
    }
  }

  // -- internals ---------------------------------------------------------------------------------

  async #token(endpoint: string, form: Record<string, string>): Promise<TokenResponse> {
    const authorization = Buffer.from(`${this.#clientId}:${this.#clientSecret}`).toString('base64');
    return this.#fetchJson<TokenResponse>(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${authorization}`,
      },
      body: new URLSearchParams(form).toString(),
    });
  }

  async #organizationToken(
    endpoint: string,
    refreshToken: string,
    organizationId: string,
  ): Promise<{ principal: StaffPrincipal; accessToken: string; refreshToken?: string }> {
    const tokens = await this.#token(endpoint, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      organization_id: organizationId,
    });
    const accessToken = tokens.access_token;
    if (!accessToken) throw new ValidationError('The issuer returned no organization token.');

    const claims = decodeJwt(accessToken);
    const principal = await this.#toPrincipal(claims);
    if (!principal || principal.kind !== 'staff') {
      throw new ValidationError(
        `The organization token for ${organizationId} does not map to a tenant this store serves.`,
      );
    }
    return {
      principal,
      accessToken,
      ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }),
    };
  }

  /**
   * userinfo is where the organization's NAME lives, and the name is our slug. The id token
   * carries only ids. Both are read while the issuer is up, and both are cached, because after
   * this moment the data plane may never reach it again.
   */
  async #learnOrganizations(
    userinfoEndpoint: string,
    accessToken: string | undefined,
    idTokenPayload: JWTPayload,
    subject: string,
  ): Promise<void> {
    if (!accessToken) return;
    let profile: { organization_data?: { id: string; name: string }[] };
    try {
      profile = await this.#fetchJson(userinfoEndpoint, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
    } catch {
      return;
    }
    const directory = { ...this.#cache.organizations };
    for (const organization of profile.organization_data ?? []) {
      const roles = rolesForOrganization(idTokenPayload['organization_roles'], organization.id);
      const existing = directory[organization.id];
      directory[organization.id] = {
        slug: organization.name,
        roles: { ...existing?.roles, ...(roles.length > 0 ? { [subject]: roles } : {}) },
      };
    }
    this.#cache.organizations = directory;
    this.#writeCache();
  }

  async #organizationFor(tenantId: string): Promise<string | null> {
    for (const [organizationId, entry] of Object.entries(this.#cache.organizations ?? {})) {
      if ((await this.#resolveTenantIdBySlug?.(entry.slug)) === tenantId) return organizationId;
    }
    return null;
  }
}

function nowPlus(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}
