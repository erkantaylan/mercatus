import { describe, expect, it } from 'vitest';

import {
  MissingTenantContextError,
  NotFoundError,
  StubAuthAdapter,
  currentTenant,
  normalisePageRequest,
  pagedResult,
  runInTenant,
  toErrorEnvelope,
  tryCurrentTenant,
} from './index.js';

const SECRET = 'stub-secret-for-tests-0123456789abcdef';
const ACME = '11111111-1111-4111-8111-111111111111';
const BORG = '22222222-2222-4222-8222-222222222222';

function adapter(): StubAuthAdapter {
  return new StubAuthAdapter({ secret: SECRET, nodeEnv: 'test' });
}

describe('StubAuthAdapter', () => {
  it('mints and verifies a tenant-scoped staff token', async () => {
    const auth = adapter();
    const token = await auth.issueStaffToken({ subject: 'user-1', tenantId: ACME, roles: ['owner'] });
    const principal = await auth.verify(token);

    expect(principal).toMatchObject({ kind: 'staff', subject: 'user-1', tenantId: ACME, roles: ['owner'] });
  });

  it('mints and verifies a tenant-less shopper token (BI2)', async () => {
    const auth = adapter();
    const principal = await auth.verify(await auth.issueShopperToken({ subject: '+905550000001' }));

    expect(principal).toMatchObject({ kind: 'shopper', subject: '+905550000001', tenantId: null });
  });

  it('returns null, and does not throw, for garbage, a foreign signature and an expired token', async () => {
    const auth = adapter();
    const foreign = new StubAuthAdapter({ secret: 'a-completely-different-secret-value!!', nodeEnv: 'test' });

    expect(await auth.verify('')).toBeNull();
    expect(await auth.verify('not-a-jwt')).toBeNull();
    expect(await auth.verify(await foreign.issueStaffToken({ subject: 'u', tenantId: ACME }))).toBeNull();
    expect(
      await auth.verify(await auth.issueStaffToken({ subject: 'u', tenantId: ACME, ttlSeconds: -10 })),
    ).toBeNull();
  });

  it('exchanges a stub code and switches tenant with tokenForTenant (BC1)', async () => {
    const auth = adapter();
    const exchanged = await auth.exchange({ code: `stub:staff:user-1:${ACME}`, redirectUri: 'http://localhost:5173' });
    expect(exchanged.principal).toMatchObject({ kind: 'staff', tenantId: ACME });

    const switched = await auth.tokenForTenant({ refreshToken: exchanged.refreshToken ?? '', tenantId: BORG });
    expect(switched.principal.tenantId).toBe(BORG);
    expect(await auth.verify(switched.accessToken)).toMatchObject({ tenantId: BORG });
  });

  it('refuses to exist in production', () => {
    expect(() => new StubAuthAdapter({ secret: SECRET, nodeEnv: 'production' })).toThrow(/production/);
  });
});

describe('tenant context', () => {
  it('throws outside a tenant and resolves inside one', async () => {
    expect(tryCurrentTenant()).toBeUndefined();
    expect(() => currentTenant()).toThrow(MissingTenantContextError);

    const seen = await runInTenant(
      { tenantId: ACME, slug: 'acme', source: 'token', subject: 'user-1' },
      async () => Promise.resolve(currentTenant()),
    );
    expect(seen.slug).toBe('acme');
    expect(tryCurrentTenant()).toBeUndefined();
  });
});

describe('errors and paging', () => {
  it('envelopes a known error and hides an unknown one', () => {
    expect(new NotFoundError('No such product.').toEnvelope()).toEqual({
      error: { code: 'NOT_FOUND', message: 'No such product.' },
    });
    expect(toErrorEnvelope(new TypeError('secret internals'))).toEqual({
      error: { code: 'INTERNAL', message: 'Internal error.' },
    });
  });

  it('clamps a page request and shapes a list', () => {
    expect(normalisePageRequest({ limit: 10_000, offset: -5 })).toEqual({ limit: 200, offset: 0 });
    expect(pagedResult([1, 2], 2)).toEqual({ items: [1, 2], total: 2 });
  });
});
