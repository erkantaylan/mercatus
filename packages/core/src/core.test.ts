import { describe, expect, it } from 'vitest';

import {
  LogtoAuthAdapter,
  MissingTenantContextError,
  NotFoundError,
  SESSION_COOKIE_NAME,
  SessionIssuer,
  StubAuthAdapter,
  readCookie,
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

describe('SessionIssuer', () => {
  const session = new SessionIssuer({ secret: SECRET, ttlSeconds: 60, secureCookie: false });

  it('round-trips a staff principal through a cookie the store signed itself', async () => {
    const token = await session.issue({
      kind: 'staff',
      subject: 'user-1',
      tenantId: ACME,
      roles: ['owner'],
      expiresAt: 0,
    });
    const cookie = session.cookie(token);
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain('HttpOnly');
    // SameSite=Lax, not Strict: the cookie has to survive the redirect back from the issuer.
    expect(cookie).toContain('SameSite=Lax');

    const value = readCookie(`other=1; ${cookie.split(';')[0] ?? ''}`, SESSION_COOKIE_NAME);
    expect(await session.verify(value)).toMatchObject({
      kind: 'staff',
      subject: 'user-1',
      tenantId: ACME,
      roles: ['owner'],
    });
  });

  it('keeps a shopper session tenant-less (BI2)', async () => {
    const token = await session.issue({
      kind: 'shopper',
      subject: 'shopper-1',
      tenantId: null,
      expiresAt: 0,
    });
    expect(await session.verify(token)).toMatchObject({ kind: 'shopper', tenantId: null });
  });

  it('refuses a cookie signed with another key, and anything malformed', async () => {
    const other = new SessionIssuer({ secret: `${SECRET}-different`, secureCookie: false });
    const foreign = await other.issue({
      kind: 'shopper',
      subject: 'x',
      tenantId: null,
      expiresAt: 0,
    });
    expect(await session.verify(foreign)).toBeNull();
    expect(await session.verify('not-a-jwt')).toBeNull();
    expect(await session.verify(undefined)).toBeNull();
  });

  it('refuses a secret jose cannot use for HS256', () => {
    expect(() => new SessionIssuer({ secret: 'too-short' })).toThrow(/at least 32/);
  });
});

describe('LogtoAuthAdapter', () => {
  const oidc = new LogtoAuthAdapter({
    issuer: 'http://127.0.0.1:1/oidc',
    cachePath: '/nonexistent/identity-cache.json',
  });

  it('is the oidc adapter and starts with an empty directory', () => {
    expect(oidc.name).toBe('oidc');
    expect(oidc.knownOrganizations()).toEqual({});
  });

  it('verifies nothing and throws nothing with no cached key set (CG1)', async () => {
    expect(await oidc.verify('')).toBeNull();
    expect(await oidc.verify('a.b.c')).toBeNull();
  });

  it('reports an unreachable issuer instead of throwing (CG3)', async () => {
    expect(await oidc.issuerReachable()).toBe(false);
  });

  it('refuses to start a login when the instance is not registered', async () => {
    await expect(
      oidc.authorizeUrl({ redirectUri: 'http://127.0.0.1:4002/auth/callback', audience: 'staff', state: 's' }),
    ).rejects.toThrow(/not registered/);
  });
});
