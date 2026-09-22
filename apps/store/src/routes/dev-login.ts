/**
 * `/dev/login/*` (BUILD-PLAN §6.2). Registered ONLY when AUTH_ADAPTER=stub.
 *
 * These two routes mint tokens with no credential check whatsoever, which is exactly what is
 * wanted while the Identity phase is still ahead and exactly what must never exist beside a real
 * issuer. Two independent guards: this file is not registered unless the configured adapter is
 * the stub, and StubAuthAdapter refuses to construct at all under NODE_ENV=production.
 *
 * The audience split is the token's own (BH1): a staff token carries `tid` and roles, a shopper
 * token carries neither and never can (BI2).
 */
import {
  devLoginResultSchema,
  devShopperLoginBodySchema,
  devStaffLoginBodySchema,
  errorEnvelopeSchema,
} from '@mercatus/contracts';
import type { MercatusServer } from '@mercatus/core';
import { StubAuthAdapter, TenantNotFoundError } from '@mercatus/core';

import type { StoreDeps } from '../deps.js';

/**
 * A stable, obviously-fake subject. In the Identity phase these become real user ids from the
 * issuer; nothing downstream cares which, because a subject is opaque everywhere it is used.
 */
function staffSubject(slug: string): string {
  return `dev-staff:${slug}`;
}

function shopperSubject(phone: string): string {
  return `dev-shopper:${phone}`;
}

export function registerDevLoginRoutes(app: MercatusServer, deps: StoreDeps): void {
  const adapter = deps.adapter;
  if (!(adapter instanceof StubAuthAdapter)) return;

  app.post(
    '/dev/login/staff',
    {
      schema: {
        summary: 'Mint a tenant-scoped staff token (stub adapter only)',
        tags: ['dev'],
        body: devStaffLoginBodySchema,
        response: { 200: devLoginResultSchema, 404: errorEnvelopeSchema },
      },
    },
    async (req) => {
      const tenant = await deps.tenants.bySlug(req.body.slug);
      if (!tenant) throw new TenantNotFoundError();
      const subject = staffSubject(tenant.slug);
      // BC1: scoped to exactly one tenant. Switching stores mints another token, never a wider one.
      const accessToken = await adapter.issueStaffToken({
        subject,
        tenantId: tenant.id,
        roles: [req.body.role],
      });
      const principal = await adapter.verify(accessToken);
      return { accessToken, expiresAt: principal?.expiresAt ?? 0 };
    },
  );

  app.post(
    '/dev/login/shopper',
    {
      schema: {
        summary: 'Mint a tenant-less shopper token (stub adapter only)',
        tags: ['dev'],
        body: devShopperLoginBodySchema,
        response: { 200: devLoginResultSchema },
      },
    },
    async (req) => {
      const subject = shopperSubject(req.body.phone);
      // No tenant claim, on purpose. The store a shopper is buying from comes from the route,
      // and the pair is what scopes the query (BI2).
      const accessToken = await adapter.issueShopperToken({ subject });
      const principal = await adapter.verify(accessToken);
      return { accessToken, expiresAt: principal?.expiresAt ?? 0 };
    },
  );

  app.log.warn('dev login routes registered -- AUTH_ADAPTER=stub');
}
