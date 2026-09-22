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
  loginCallbackQuerySchema,
  sessionInfoSchema,
  startLoginQuerySchema,
} from '@mercatus/contracts';
import type { MercatusServer } from '@mercatus/core';
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

/** The absolute URL the issuer redirects back to. It must match what was registered with it. */
function callbackUrl(deps: StoreDeps, requestOrigin: string): string {
  return `${deps.config.storePublicUrl ?? requestOrigin}/auth/callback`;
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
      const redirectUri = callbackUrl(deps, `${req.protocol}://${req.host}`);
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
      let claims: z.infer<typeof stateClaimsSchema>;
      try {
        const { payload } = await jwtVerify(req.query.state, stateKey, {
          issuer: STATE_ISSUER,
          algorithms: ['HS256'],
        });
        claims = stateClaimsSchema.parse(payload);
      } catch {
        // A state we did not sign, or one that expired. Same answer for both (S1).
        throw new ValidationError('The login state is not valid; start again at /auth/login.');
      }

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
