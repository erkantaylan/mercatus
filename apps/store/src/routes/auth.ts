/**
 * `/auth/*` -- the OIDC round trip, and the store's own session.
 *
 * THE SESSION COOKIE IS THE POINT (README Q20). The store performs the OIDC login exactly once,
 * then issues a cookie it signed itself. Every request after that is verified against a key this
 * process holds, with no call to anybody. That is what keeps a dedicated instance on a customer's
 * server selling while our control plane is down: existing shoppers keep browsing, ordering and
 * checking out, and only a first-ever sign-in to that store fails (CG1).
 *
 * The same four routes serve BOTH adapters. With `AUTH_ADAPTER=stub` the authorize URL is the dev
 * login page and the code is `stub:<kind>:<subject>[:<tenant>]`; with `oidc` it is Logto. Nothing
 * here knows which -- that is the whole reason the adapter interface exists (BUILD-PLAN §4).
 *
 * `state` is a short-lived JWT signed with the session key rather than a row in a table: it has to
 * survive a redirect, not a restart, and a server-side store would be the only stateful thing in
 * the data plane.
 */
import {
  errorEnvelopeSchema,
  exchangeBodySchema,
  exchangeResultSchema,
  loginCallbackQuerySchema,
  sessionInfoSchema,
  startLoginQuerySchema,
} from '@mercatus/contracts';
import type { MercatusServer, Principal } from '@mercatus/core';
import { UnauthenticatedError, ValidationError } from '@mercatus/core';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';

import type { StoreDeps } from '../deps.js';

const STATE_ISSUER = 'mercatus-login-state';
const STATE_TTL_SECONDS = 600;

const stateClaimsSchema = z.object({
  next: z.string().startsWith('/'),
  audience: z.enum(['staff', 'shopper']),
  redirectUri: z.url(),
});

/**
 * The absolute URL the issuer redirects back to. It must match what was registered with it, as a
 * STRING (lessons/14), which is why every one of these is built from the same variable the
 * instance reported at registration rather than from anything this request carries.
 *
 * Three landing places, one client. `store` ends here with a cookie; the other two end at a front
 * end which presents the code to `POST /auth/exchange` and holds the session as a token instead.
 */
function callbackUrl(deps: StoreDeps, via: 'store' | 'storefront' | 'dashboard', requestOrigin: string): string {
  if (via === 'storefront') {
    const base = deps.config.storefrontPublicUrl;
    if (base === undefined) {
      throw new ValidationError('This store has no storefront to sign in for.', {
        logDetail: 'STOREFRONT_PUBLIC_URL is not set; /auth/login?via=storefront cannot be served',
      });
    }
    return `${base.replace(/\/+$/, '')}/api/auth/callback`;
  }
  if (via === 'dashboard') {
    const base = deps.config.dashboardPublicUrl;
    if (base === undefined) {
      throw new ValidationError('This store has no dashboard to sign in for.', {
        logDetail: 'DASHBOARD_PUBLIC_URL is not set; /auth/login?via=dashboard cannot be served',
      });
    }
    return `${base.replace(/\/+$/, '')}/callback`;
  }
  return `${deps.config.storePublicUrl ?? requestOrigin}/auth/callback`;
}

/** The contact details the issuer knew, when the subject spells them out. Never an identity. */
function contactOf(principal: Principal): { phone: string | null; name: string | null } {
  // The stub's shopper subject is `dev-shopper:+90...`, which is where the storefront's readable
  // phone cookie came from before this release. A real issuer's subject is opaque and says
  // nothing about a phone, so the checkout form asks for one -- which is the honest behaviour
  // either way: the phone is contact detail on an order, not who the person is (BI2).
  const match = /^dev-shopper:(\+[1-9]\d{6,14})$/.exec(principal.subject);
  return { phone: match?.[1] ?? null, name: null };
}

export function registerAuthRoutes(app: MercatusServer, deps: StoreDeps): void {
  const stateKey = new TextEncoder().encode(deps.config.sessionSecret);

  const signState = (claims: z.infer<typeof stateClaimsSchema>): Promise<string> =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(STATE_ISSUER)
      .setIssuedAt()
      .setExpirationTime(`${STATE_TTL_SECONDS}s`)
      .sign(stateKey);

  app.get(
    '/auth/login',
    {
      schema: {
        summary: 'Start an interactive login; 302 to the issuer',
        tags: ['auth'],
        querystring: startLoginQuerySchema,
        response: { 302: z.null(), 400: errorEnvelopeSchema },
      },
    },
    async (req, reply) => {
      const redirectUri = callbackUrl(deps, req.query.via, `${req.protocol}://${req.host}`);
      const state = await signState({
        next: req.query.next,
        audience: req.query.audience,
        redirectUri,
      });
      const url = await deps.adapter.authorizeUrl({
        redirectUri,
        audience: req.query.audience,
        state,
        // CD3: a shopper has no organization, so a tenant hint is meaningless for one.
        ...(req.query.audience === 'staff' && req.query.slug !== undefined
          ? { tenantSlug: req.query.slug }
          : {}),
      });
      await reply.redirect(url, 302);
    },
  );

  /** A state this process signed, or one generic refusal for every way it can be wrong (S1). */
  const readState = async (state: string): Promise<z.infer<typeof stateClaimsSchema>> => {
    try {
      const { payload } = await jwtVerify(state, stateKey, {
        issuer: STATE_ISSUER,
        algorithms: ['HS256'],
      });
      return stateClaimsSchema.parse(payload);
    } catch {
      // A state we did not sign, or one that expired. Same answer for both (S1).
      throw new ValidationError('The login state is not valid; start again at /auth/login.');
    }
  };

  app.get(
    '/auth/callback',
    {
      schema: {
        summary: 'Exchange the authorization code and set the store session cookie',
        tags: ['auth'],
        querystring: loginCallbackQuerySchema,
        response: { 302: z.null(), 400: errorEnvelopeSchema },
      },
    },
    async (req, reply) => {
      const claims = await readState(req.query.state);

      const exchanged = await deps.adapter.exchange({
        code: req.query.code,
        redirectUri: claims.redirectUri,
      });

      // From here on the issuer is not needed again for this person. The cookie is ours.
      const session = await deps.session.issue(exchanged.principal);
      void reply.header('set-cookie', deps.session.cookie(session));
      req.log.info(
        {
          kind: exchanged.principal.kind,
          subject: exchanged.principal.subject,
          adapter: deps.adapter.name,
        },
        'session issued',
      );
      await reply.redirect(claims.next, 302);
    },
  );

  app.get(
    '/auth/session',
    {
      schema: {
        summary: 'Who the caller is, according to the store',
        tags: ['auth'],
        response: { 200: sessionInfoSchema, 401: errorEnvelopeSchema },
      },
    },
    (req) => {
      const principal = req.principal;
      if (!principal) throw new UnauthenticatedError(undefined, { logDetail: 'no session cookie' });
      return {
        kind: principal.kind,
        subject: principal.subject,
        tenantId: principal.tenantId,
        roles: principal.kind === 'staff' ? [...principal.roles] : [],
        expiresAt: principal.expiresAt,
        issuedBy: deps.adapter.name,
      };
    },
  );

  /**
   * THE SAME ROUND TRIP, FOR A FRONT END ON ANOTHER ORIGIN (v2.0.0).
   *
   * The storefront is a server on its own host and the dashboard is a SPA on a third; neither can
   * be sent this store's host-only cookie, and neither may hold a client secret. So they land the
   * code here and get the session as a TOKEN, which they present as a bearer -- verified by the
   * very same key that verifies the cookie (packages/core/src/auth/plugin.ts).
   *
   * This is what made "real OIDC" and "a browser you can shop in" stop being mutually exclusive:
   * before it, both front ends could only mint tokens through `/dev/login/*`, which does not exist
   * unless the adapter is the stub.
   */
  app.post(
    '/auth/exchange',
    {
      schema: {
        summary: 'Exchange an authorization code for this store\'s session token',
        tags: ['auth'],
        body: exchangeBodySchema,
        response: { 200: exchangeResultSchema, 400: errorEnvelopeSchema },
      },
    },
    async (req) => {
      const claims = await readState(req.body.state);
      const exchanged = await deps.adapter.exchange({
        code: req.body.code,
        redirectUri: claims.redirectUri,
      });
      const principal = exchanged.principal;
      const accessToken = await deps.session.issue(principal);
      const verified = await deps.session.verify(accessToken);
      const tenant = principal.tenantId === null ? null : await deps.tenants.byId(principal.tenantId);
      req.log.info(
        { kind: principal.kind, subject: principal.subject, adapter: deps.adapter.name, via: claims.audience },
        'session issued to a front end',
      );
      return {
        accessToken,
        expiresAt: verified?.expiresAt ?? principal.expiresAt,
        kind: principal.kind,
        subject: principal.subject,
        tenantId: principal.tenantId,
        tenantSlug: tenant?.slug ?? null,
        roles: principal.kind === 'staff' ? [...principal.roles] : [],
        ...contactOf(principal),
        next: claims.next,
        issuedBy: deps.adapter.name,
      };
    },
  );

  app.post(
    '/auth/logout',
    {
      schema: {
        summary: 'Clear the store session cookie',
        tags: ['auth'],
        response: { 204: z.null() },
      },
    },
    async (_req, reply) => {
      void reply.header('set-cookie', deps.session.clearCookie());
      await reply.status(204).send(null);
    },
  );
}
