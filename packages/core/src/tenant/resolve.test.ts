/**
 * Tenant resolution (§3.6). No database, no server -- this is a pure function, and it is the
 * seam that decides whether tier 2 is an addition or a rewrite, so it is worth pinning down.
 */
import { describe, expect, it } from 'vitest';

import { resolveTenantCandidate, tenantCandidates } from './resolve.js';

const pooled = { mode: 'pooled', baseHost: 'localtest.me' } as const;
const dedicated = { mode: 'dedicated', tenantSlug: 'zenith', baseHost: 'localtest.me' } as const;

describe('resolveTenantCandidate', () => {
  it('finds nothing in a request that names no tenant', () => {
    expect(resolveTenantCandidate({ hostname: 'localhost', url: '/health' }, pooled)).toBeNull();
  });

  it('reads a path candidate', () => {
    expect(resolveTenantCandidate({ hostname: 'localhost', url: '/t/acme/products' }, pooled)).toEqual({
      slug: 'acme',
      source: 'path',
    });
  });

  it('reads a host candidate, and prefers it to the path (tier 2 arrives here)', () => {
    expect(
      resolveTenantCandidate({ hostname: 'acme.localtest.me', url: '/t/borg/products' }, pooled),
    ).toEqual({ slug: 'acme', source: 'host' });
  });

  it('ignores a host outside the deployment’s own suffix', () => {
    expect(resolveTenantCandidate({ hostname: 'acme.example.com', url: '/health' }, pooled)).toBeNull();
  });

  it('ignores reserved labels, which are infrastructure rather than merchants', () => {
    for (const label of ['platform', 'admin', 'id', 'bank', 'api', 'www']) {
      expect(
        resolveTenantCandidate({ hostname: `${label}.localtest.me`, url: '/health' }, pooled),
      ).toBeNull();
    }
  });

  it('ignores a deeper host label: acme.shop.localtest.me is not tenant "acme.shop"', () => {
    expect(
      resolveTenantCandidate({ hostname: 'acme.shop.localtest.me', url: '/health' }, pooled),
    ).toBeNull();
  });

  it('rejects a path segment that is not a slug', () => {
    expect(resolveTenantCandidate({ hostname: 'localhost', url: '/t/NOT_A_SLUG/x' }, pooled)).toBeNull();
    expect(resolveTenantCandidate({ hostname: 'localhost', url: '/t/-bad-/x' }, pooled)).toBeNull();
  });

  it('pins a dedicated instance to its own tenant, whatever the URL says', () => {
    expect(
      resolveTenantCandidate({ hostname: 'acme.localtest.me', url: '/t/borg/products' }, dedicated),
    ).toEqual({ slug: 'zenith', source: 'deployment' });
  });

  it('keeps every candidate, so a disagreement can be refused rather than resolved', () => {
    // The caller turns this into a 403: a pinned instance serving another merchant's catalog
    // under that merchant's URL is exactly the failure BI1 describes.
    expect(
      tenantCandidates({ hostname: 'acme.localtest.me', url: '/t/borg/products' }, dedicated),
    ).toEqual([
      { slug: 'zenith', source: 'deployment' },
      { slug: 'acme', source: 'host' },
      { slug: 'borg', source: 'path' },
    ]);
  });

  it('a host port does not become part of the slug', () => {
    expect(
      resolveTenantCandidate({ hostname: 'acme.localtest.me:4002', url: '/health' }, pooled),
    ).toEqual({ slug: 'acme', source: 'host' });
  });
});
