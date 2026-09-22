/**
 * Tenant resolution (BUILD-PLAN §3.6).
 *
 * Takes a REQUEST, not a route parameter. That is the whole trick: tier 2 (a merchant's own
 * domain) then becomes "add a domains table and point DNS" instead of touching every route (DP).
 *
 * Order is deployment -> host -> path, first hit wins:
 *
 *   deployment  a dedicated instance is pinned to TENANT_SLUG and serves nothing else (CC1)
 *   host        `acme.localtest.me` -- one label under BASE_HOST, reserved labels excluded
 *   path        `/t/acme/...`
 *
 * What comes back is a CANDIDATE. For staff requests the tenant comes from the token, and a
 * candidate that disagrees with the token is a 403, never a switch (BI1). The candidate only
 * becomes a tenant after a lookup in `tenants`, which is the one table without RLS because it is
 * what establishes the context everything else needs.
 */

export type TenantCandidateSource = 'deployment' | 'host' | 'path';

export interface TenantCandidate {
  readonly slug: string;
  readonly source: TenantCandidateSource;
}

export interface TenantResolutionConfig {
  readonly mode: 'pooled' | 'dedicated';
  /** Dedicated mode only. The instance answers for this tenant and refuses every other. */
  readonly tenantSlug?: string | undefined;
  /** The DNS suffix this deployment owns, e.g. `localtest.me`. */
  readonly baseHost: string;
}

export interface ResolvableRequest {
  readonly hostname: string;
  readonly url: string;
}

/**
 * Labels under BASE_HOST that are infrastructure, not merchants. A store called `admin` would
 * otherwise shadow the console; reserving them costs nothing and the list is short on purpose.
 */
export const RESERVED_HOST_LABELS: readonly string[] = [
  'platform',
  'id',
  'identity',
  'admin',
  'bank',
  'api',
  'www',
];

/** Same shape as the slug in @mercatus/contracts. Duplicated rather than imported: core does not depend on contracts. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const PATH_RE = /^\/t\/([^/?#]+)/;

function isSlug(value: string): boolean {
  return SLUG_RE.test(value);
}

/** Fastify 5 keeps the port out of `hostname`, but a raw Host header may still carry one. */
function hostLabel(hostname: string, baseHost: string): string | null {
  const host = (hostname.split(':')[0] ?? '').toLowerCase();
  const suffix = `.${baseHost.toLowerCase()}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  if (!label || label.includes('.')) return null;
  if (RESERVED_HOST_LABELS.includes(label)) return null;
  return isSlug(label) ? label : null;
}

function pathLabel(url: string): string | null {
  const match = PATH_RE.exec(url);
  const raw = match?.[1];
  if (!raw) return null;
  const slug = decodeURIComponent(raw).toLowerCase();
  return isSlug(slug) ? slug : null;
}

/**
 * Every candidate the request carries, in precedence order.
 *
 * The full list matters, not just the winner: a dedicated instance that is pinned to `zenith` and
 * receives `/t/acme/products` has two candidates that disagree, and the caller turns that into a
 * refusal rather than quietly serving zenith's catalog under acme's URL.
 */
export function tenantCandidates(
  req: ResolvableRequest,
  cfg: TenantResolutionConfig,
): TenantCandidate[] {
  const found: TenantCandidate[] = [];

  if (cfg.mode === 'dedicated' && cfg.tenantSlug) {
    found.push({ slug: cfg.tenantSlug.toLowerCase(), source: 'deployment' });
  }

  const host = hostLabel(req.hostname, cfg.baseHost);
  if (host) found.push({ slug: host, source: 'host' });

  const path = pathLabel(req.url);
  if (path) found.push({ slug: path, source: 'path' });

  return found;
}

/** The winner, or null when the request names no tenant at all (`/health`, `/docs`). */
export function resolveTenantCandidate(
  req: ResolvableRequest,
  cfg: TenantResolutionConfig,
): TenantCandidate | null {
  return tenantCandidates(req, cfg)[0] ?? null;
}
