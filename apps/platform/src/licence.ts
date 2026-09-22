/**
 * The signed licence -- a JWT a data plane verifies OFFLINE (CG1, CC3).
 *
 * Ed25519, not HMAC, and that is the load-bearing decision in this file. A dedicated store runs
 * on a machine whose owner has root (CE5). If the licence were signed with a shared secret, that
 * box would hold a key which mints licences -- for itself and for every other tenant -- and CE1
 * would be broken by the licensing mechanism itself. With an asymmetric key the instance holds
 * only the public half: it can check a licence and it cannot write one.
 *
 * The public key is published at `GET /licence/jwks`. The instance fetches it once and caches it,
 * which is what lets it keep verifying while the control plane is down (CE4: it pulls; we never
 * push).
 *
 * `exp` is the end of `valid_until`, NOT a short session lifetime. The two clocks in the design
 * are separate on purpose: this one is "what the merchant paid for", and the grace window in the
 * data plane is "how long we tolerate not being able to reach the control plane" (CG2, CG3).
 */
import { createPublicKey } from 'node:crypto';

import type { Entitlements, LicenceRow, TenantRow } from '@mercatus/db-platform';
import type { JWK, JWTPayload } from 'jose';
import {
  calculateJwkThumbprint,
  exportJWK,
  importJWK,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
} from 'jose';

export const LICENCE_ISSUER = 'mercatus-platform';
export const LICENCE_AUDIENCE = 'mercatus-store';
export const LICENCE_ALG = 'EdDSA';

export interface LicenceClaims extends JWTPayload {
  readonly slug: string;
  readonly tier: 'pooled' | 'dedicated';
  /** What the tenant may do RIGHT NOW. `passive` blocks checkout and nothing else (CG3, ES). */
  readonly status: 'active' | 'passive';
  readonly entitlements: Entitlements;
  readonly validUntil: string;
  readonly licenceId: string;
}

export interface SignedLicence {
  readonly licence: string;
  readonly licenceId: string;
  readonly keyId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface LicenceSigner {
  sign(tenant: TenantRow, licence: LicenceRow): Promise<SignedLicence>;
  /** The public half, in JWKS form, for an instance to cache. */
  jwks(): { keys: JWK[] };
  keyId(): string;
}

/** A licence is valid to the END of its last day, in UTC. A date is not an instant. */
function endOfDay(validUntil: string): Date {
  return new Date(`${validUntil}T23:59:59.000Z`);
}

export async function createLicenceSigner(privateKeyPem: string): Promise<LicenceSigner> {
  const spki = createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }).toString();
  const privateKey = await importPKCS8(privateKeyPem, LICENCE_ALG);
  const publicKey = await importSPKI(spki, LICENCE_ALG);
  const jwk = await exportJWK(publicKey);
  // The thumbprint (RFC 7638), so the kid changes when and only when the key does. An instance
  // that sees an unknown kid knows to re-fetch the key set rather than to reject the licence.
  const kid = await calculateJwkThumbprint(jwk);

  return {
    keyId: () => kid,
    jwks: () => ({ keys: [{ ...jwk, kid, alg: LICENCE_ALG, use: 'sig' }] }),
    sign: async (tenant, licence) => {
      const issuedAt = new Date();
      const expiresAt = endOfDay(licence.validUntil);
      const claims: LicenceClaims = {
        slug: tenant.slug,
        tier: tenant.tier,
        // A tenant that has not paid yet is not an active licence holder. `pending` and
        // `passive` both mean "no checkout"; only the reason differs, and the reason is the
        // tenant's status, which the console shows.
        status: tenant.status === 'active' ? 'active' : 'passive',
        entitlements: licence.entitlements,
        validUntil: licence.validUntil,
        licenceId: licence.id,
      };
      const token = await new SignJWT(claims)
        .setProtectedHeader({ alg: LICENCE_ALG, kid, typ: 'JWT' })
        .setIssuer(LICENCE_ISSUER)
        .setAudience(LICENCE_AUDIENCE)
        .setSubject(tenant.id)
        .setIssuedAt(issuedAt)
        .setExpirationTime(expiresAt)
        .sign(privateKey);
      return {
        licence: token,
        licenceId: licence.id,
        keyId: kid,
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
    },
  };
}

/**
 * The verification a data plane performs, written once here so the control plane's own test can
 * prove the licence it issues is checkable with nothing but the public key. The store-side
 * implementation in task 10 caches the key set on disk and is otherwise these four lines.
 */
export async function verifyLicenceToken(
  token: string,
  publicJwk: JWK,
): Promise<LicenceClaims & JWTPayload> {
  const key = await importJWK(publicJwk, LICENCE_ALG);
  const { payload } = await jwtVerify(token, key, {
    issuer: LICENCE_ISSUER,
    audience: LICENCE_AUDIENCE,
    algorithms: [LICENCE_ALG],
  });
  return payload as LicenceClaims & JWTPayload;
}

/** One year, the POC's only plan. Written as a function so "now" is never captured at import. */
export function defaultValidUntil(days = 365): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
