/**
 * The schemas are the contract (§6.0), so what is asserted here is the things a route would
 * otherwise have to remember: that money is an integer, that a slug cannot be a uuid, that a
 * patch with a typo is a 400 rather than a silent no-op, and that the error envelope's codes come
 * from one list rather than two.
 */
import { ERROR_CODES } from '@mercatus/core';
import { describe, expect, it } from 'vitest';

import {
  checkoutBodySchema,
  createProductBodySchema,
  errorEnvelopeSchema,
  heartbeatBodySchema,
  licenceViewSchema,
  minorAmountSchema,
  pageQuerySchema,
  patchProductBodySchema,
  patchSettingsBodySchema,
  productSchema,
  signupBodySchema,
  slugSchema,
} from '../src/index.js';

describe('error envelope', () => {
  it('accepts a code from core and rejects one that is not in the list', () => {
    expect(
      errorEnvelopeSchema.safeParse({ error: { code: 'PRODUCT_NOT_FOUND', message: 'no' } }).success,
    ).toBe(true);
    expect(
      errorEnvelopeSchema.safeParse({ error: { code: 'TEAPOT', message: 'no' } }).success,
    ).toBe(false);
  });

  it('covers every code core can throw -- one list, never two', () => {
    for (const code of ERROR_CODES) {
      expect(errorEnvelopeSchema.safeParse({ error: { code, message: 'x' } }).success).toBe(true);
    }
  });

  it('keeps LICENCE_PASSIVE and CONTROL_PLANE_UNREACHABLE as distinct codes (CG3)', () => {
    expect(ERROR_CODES).toContain('LICENCE_PASSIVE');
    expect(ERROR_CODES).toContain('CONTROL_PLANE_UNREACHABLE');
  });
});

describe('money', () => {
  it('is an integer in minor units -- 19.99 is not a price', () => {
    expect(minorAmountSchema.safeParse(1999).success).toBe(true);
    expect(minorAmountSchema.safeParse(19.99).success).toBe(false);
    expect(minorAmountSchema.safeParse(-1).success).toBe(false);
  });
});

describe('slug (BV3)', () => {
  it.each(['acme', 'borg', 'acme-supply', 'a1'])('accepts %s', (value) => {
    expect(slugSchema.safeParse(value).success).toBe(true);
  });

  it.each(['A', 'Acme', '-acme', 'acme-', 'a', 'acme_supply', 'acme supply'])(
    'rejects %s',
    (value) => {
      expect(slugSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('paging', () => {
  it('defaults to 50 and clamps at 200, matching core', () => {
    expect(pageQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(pageQuerySchema.safeParse({ limit: 10_000 }).success).toBe(false);
    expect(pageQuerySchema.parse({ limit: '20', offset: '40' })).toEqual({ limit: 20, offset: 40 });
  });
});

describe('products', () => {
  it('a create body needs sku, title, price and stock', () => {
    const ok = createProductBodySchema.safeParse({
      sku: 'ACM-001',
      title: 'Anvil',
      priceMinor: 249900,
      stock: 12,
    });
    expect(ok.success).toBe(true);
  });

  it('a patch may be any subset, but an unknown key is a 400 rather than a silent no-op', () => {
    expect(patchProductBodySchema.safeParse({ stock: 3 }).success).toBe(true);
    expect(patchProductBodySchema.safeParse({ stockk: 3 }).success).toBe(false);
    expect(patchSettingsBodySchema.safeParse({ nmae: 'typo' }).success).toBe(false);
  });

  it('a product on the wire carries its currency separately from its amount', () => {
    const parsed = productSchema.safeParse({
      id: '3f6b0b8a-1f4a-4d2a-9c3e-0a1b2c3d4e01',
      sku: 'ACM-001',
      title: 'Anvil',
      priceMinor: 249900,
      currency: 'TRY',
      imageUrl: null,
      stock: 12,
      createdAt: '2026-09-22T00:00:00.000Z',
      updatedAt: '2026-09-22T00:00:00.000Z',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('checkout', () => {
  it('needs at least one line and a positive quantity', () => {
    const base = { shopper: { phone: '+905550000000' } };
    expect(checkoutBodySchema.safeParse({ ...base, lines: [] }).success).toBe(false);
    expect(
      checkoutBodySchema.safeParse({
        ...base,
        lines: [{ productId: '3f6b0b8a-1f4a-4d2a-9c3e-0a1b2c3d4e01', qty: 0 }],
      }).success,
    ).toBe(false);
    expect(
      checkoutBodySchema.safeParse({
        ...base,
        lines: [{ productId: '3f6b0b8a-1f4a-4d2a-9c3e-0a1b2c3d4e01', qty: 2 }],
      }).success,
    ).toBe(true);
  });

  it('rejects a phone that is not E.164', () => {
    expect(
      checkoutBodySchema.safeParse({
        shopper: { phone: '05550000000' },
        lines: [{ productId: '3f6b0b8a-1f4a-4d2a-9c3e-0a1b2c3d4e01', qty: 1 }],
      }).success,
    ).toBe(false);
  });
});

describe('licence view (CG3)', () => {
  it('carries the tenant status and the runtime state as two separate fields', () => {
    const parsed = licenceViewSchema.parse({
      status: 'active',
      state: 'grace',
      entitlements: { hidePoweredBy: true },
      validUntil: '2027-09-21',
      lastCheckedAt: '2026-09-22T00:00:00.000Z',
      lastSuccessAt: null,
      pollingSince: '2026-09-21T00:00:00.000Z',
    });
    // "we cannot reach the control plane" is never reported as "you did not pay".
    expect(parsed.status).toBe('active');
    expect(parsed.state).toBe('grace');
  });

  it('rejects a state that is not one of the four', () => {
    expect(
      licenceViewSchema.safeParse({
        status: 'active',
        state: 'offline',
        entitlements: {},
        validUntil: null,
        lastCheckedAt: null,
        lastSuccessAt: null,
        pollingSince: null,
      }).success,
    ).toBe(false);
  });
});

describe('platform', () => {
  it('signup defaults to the pooled tier', () => {
    const parsed = signupBodySchema.parse({
      phone: '+905550000000',
      name: 'Dev Owner',
      storeName: 'Acme Supply',
      slug: 'acme',
    });
    expect(parsed.tier).toBe('pooled');
  });

  it('a heartbeat carries version, tenant and counts -- and no shopper anything (CI1)', () => {
    const body = {
      version: '1.0.0',
      tenantId: '3f6b0b8a-1f4a-4d2a-9c3e-0a1b2c3d4e01',
      licenceId: null,
      productCount: 4,
      orderCount: 2,
    };
    expect(heartbeatBodySchema.parse(body)).toEqual(body);
    // Anything resembling personal data is not merely ignored -- it has nowhere to go.
    expect(Object.keys(heartbeatBodySchema.shape)).not.toContain('shoppers');
  });
});
