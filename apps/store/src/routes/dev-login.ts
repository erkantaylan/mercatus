/**
 * `/dev/login*` (BUILD-PLAN §6.2). Registered ONLY when AUTH_ADAPTER=stub.
 *
 * These routes mint tokens with no credential check whatsoever, which is exactly what is wanted
 * on a developer's machine and exactly what must never exist beside a real issuer. Two
 * independent guards: this file is not registered unless the configured adapter is the stub, and
 * StubAuthAdapter refuses to construct at all under NODE_ENV=production.
 *
 * The audience split is the token's own (BH1): a staff token carries `tid` and roles, a shopper
 * token carries neither and never can (BI2).
 *
 * `GET /dev/login` IS THE STUB'S SIGN-IN PAGE, and it is what makes the stub and a real issuer
 * interchangeable from a front end's point of view (v2.0.0). `StubAuthAdapter.authorizeUrl()` has
 * always pointed `/auth/login` at this address; until now nothing served it, so the store's own
 * OIDC round trip 404'd under the stub and both browser front ends had to call the two POST
 * routes below directly -- which is precisely why switching to `AUTH_ADAPTER=oidc` used to break
 * shopper and merchant sign-in outright.
 *
 * It is deliberately a plain HTML form with no script: a server-rendered form has nothing to
 * hydrate, so a browser driver cannot click it before it works (lessons/07a, /11).
 */
import {
  devLoginResultSchema,
  devShopperLoginBodySchema,
  devStaffLoginBodySchema,
  errorEnvelopeSchema,
} from '@mercatus/contracts';
import type { MercatusServer } from '@mercatus/core';
import { StubAuthAdapter, TenantNotFoundError, ValidationError } from '@mercatus/core';
import { z } from 'zod';

import type { StoreDeps } from '../deps.js';

const devLoginPageQuerySchema = z.object({
  redirect_uri: z.url(),
  state: z.string().min(1),
  audience: z.enum(['staff', 'shopper']).default('shopper'),
  tenant_slug: z.string().max(63).optional(),
  /** Present once the form has been submitted; absent on the first render. */
  subject: z.string().max(200).optional(),
  role: z.enum(['owner', 'staff']).optional(),
});

/** No user-supplied text ever reaches the page unescaped, dev-only or not. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The three places this store is willing to send a code back to -- the same three it registers
 * with a real issuer. The stub has no registered client to check a redirect URI against, so it
 * checks the one thing it can: that the address is one of ours. An open redirect on a sign-in
 * page is the classic one, and `dev-only` is not a reason to ship it.
 */
function allowedRedirects(deps: StoreDeps, requestOrigin: string): readonly string[] {
  const trim = (u: string): string => u.replace(/\/+$/, '');
  const store = trim(deps.config.storePublicUrl ?? requestOrigin);
  return [
    `${store}/auth/callback`,
    ...(deps.config.storefrontPublicUrl === undefined
      ? []
      : [`${trim(deps.config.storefrontPublicUrl)}/api/auth/callback`]),
    ...(deps.config.dashboardPublicUrl === undefined
      ? []
      : [`${trim(deps.config.dashboardPublicUrl)}/callback`]),
  ];
}

function page(query: z.infer<typeof devLoginPageQuerySchema>, adapterName: string): string {
  const staff = query.audience === 'staff';
  const hidden = [
    `<input type="hidden" name="redirect_uri" value="${esc(query.redirect_uri)}">`,
    `<input type="hidden" name="state" value="${esc(query.state)}">`,
    `<input type="hidden" name="audience" value="${esc(query.audience)}">`,
  ].join('\n    ');
  const fields = staff
    ? `<label for="slug">Store</label>
    <input id="slug" name="tenant_slug" value="${esc(query.tenant_slug ?? 'acme')}" autocomplete="off" required>
    <label for="role">Role</label>
    <select id="role" name="role">
      <option value="owner">owner</option>
      <option value="staff">staff</option>
    </select>
    <input type="hidden" name="subject" value="staff">`
    : `<label for="subject">Phone</label>
    <input id="subject" name="subject" value="" placeholder="+905550000001" autocomplete="off" required>
    <p class="hint">E.164, e.g. +905550000001. It is the identity this dev issuer signs you in as.</p>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>mercatus dev sign-in</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font:16px/1.5 system-ui,sans-serif;background:#f6f6f7;color:#16161a;margin:0;
       display:flex;min-height:100vh;align-items:center;justify-content:center}
  form{background:#fff;border:1px solid #dcdce0;border-radius:12px;padding:28px;width:340px;
       display:flex;flex-direction:column;gap:8px}
  h1{font-size:20px;margin:0}
  p.sub{margin:0 0 8px;color:#6a6a73;font-size:14px}
  p.hint{margin:0;color:#6a6a73;font-size:13px}
  label{font-size:13px;font-weight:600;margin-top:8px}
  input,select{font:inherit;padding:8px 10px;border:1px solid #c9c9d0;border-radius:8px}
  button{margin-top:16px;font:inherit;font-weight:600;padding:10px;border:0;border-radius:8px;
         background:#16161a;color:#fff;cursor:pointer}
</style></head>
<body>
  <form method="GET" action="/dev/login" data-dev-login="${esc(query.audience)}">
    <h1>mercatus</h1>
    <p class="sub">${staff ? 'Merchant' : 'Shopper'} sign-in &middot; ${esc(adapterName)} issuer &middot; no password, dev only</p>
    ${hidden}
    ${fields}
    <button type="submit">Sign in</button>
  </form>
</body></html>`;
}

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

  /**
   * The stub's authorization endpoint: render a form, and on submit hand back an authorization
   * code in the shape `StubAuthAdapter.exchange()` reads. Everything downstream -- the state JWT,
   * the code exchange, the session -- is the SAME path a Logto login takes.
   */
  app.get(
    '/dev/login',
    {
      schema: {
        summary: 'The stub issuer\'s sign-in page (stub adapter only)',
        tags: ['dev'],
        querystring: devLoginPageQuerySchema,
        produces: ['text/html'],
      },
    },
    async (req, reply) => {
      const origin = `${req.protocol}://${req.host}`;
      if (!allowedRedirects(deps, origin).includes(req.query.redirect_uri)) {
        throw new ValidationError('That redirect target is not one of this store\'s.', {
          logDetail: `dev login refused redirect_uri ${req.query.redirect_uri}`,
        });
      }

      const subject = req.query.subject?.trim();
      if (subject === undefined || subject === '') {
        return reply.type('text/html; charset=utf-8').send(page(req.query, adapter.name));
      }

      // BI2/BH1 again, in the code itself: a staff code names a tenant, a shopper code cannot.
      // Percent-encoded: both subjects carry a colon, which is also this code's separator.
      const code =
        req.query.audience === 'staff'
          ? `stub:staff:${encodeURIComponent(staffSubject(req.query.tenant_slug ?? ''))}:${
              req.query.tenant_slug ?? ''
            }`
          : `stub:shopper:${encodeURIComponent(shopperSubject(subject))}`;

      const back = new URL(req.query.redirect_uri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', req.query.state);
      return reply.redirect(back.toString(), 302);
    },
  );

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
