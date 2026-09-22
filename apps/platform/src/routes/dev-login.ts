/**
 * `/dev/login/operator` (the control plane's half of BUILD-PLAN §6.2's dev login). Registered
 * ONLY when AUTH_ADAPTER=stub.
 *
 * It mints an operator token with no credential check whatsoever -- which is what is wanted while
 * the Identity phase is ahead, and what must never exist beside a real issuer. Two independent
 * guards: this file is not registered unless the configured adapter is the stub, and
 * StubAuthAdapter refuses to construct at all under NODE_ENV=production.
 *
 * BH1 is a property of the token, not of a code path: this is `aud: "operator"`, a merchant's is
 * `aud: "staff"` with a tenant id, and neither verifier accepts the other's.
 */
import { devLoginResultSchema } from '@mercatus/contracts';
import type { MercatusServer } from '@mercatus/core';
import { StubAuthAdapter } from '@mercatus/core';

import { issueOperatorToken } from '../auth.js';
import type { PlatformDeps } from '../deps.js';
import { devOperatorLoginBodySchema } from '../schemas.js';

const OPERATOR_TOKEN_TTL_SECONDS = 3600;

export function registerDevLoginRoutes(app: MercatusServer, deps: PlatformDeps): void {
  if (!(deps.adapter instanceof StubAuthAdapter)) return;
  const secret = deps.config.authStubSecret;
  if (!secret) return;

  app.post(
    '/dev/login/operator',
    {
      schema: {
        summary: 'Mint a platform-console operator token (stub adapter only)',
        tags: ['dev'],
        body: devOperatorLoginBodySchema,
        response: { 200: devLoginResultSchema },
      },
    },
    async (req) => {
      const subject = req.body.subject;
      const accessToken = await issueOperatorToken(secret, {
        subject,
        ttlSeconds: OPERATOR_TOKEN_TTL_SECONDS,
      });
      return {
        accessToken,
        expiresAt: Math.floor(Date.now() / 1000) + OPERATOR_TOKEN_TTL_SECONDS,
      };
    },
  );

  app.log.warn('dev operator login registered -- AUTH_ADAPTER=stub');
}
