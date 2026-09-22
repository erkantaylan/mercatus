/**
 * Shapes this app needs that @mercatus/contracts does not carry yet.
 *
 * They are HERE rather than in `packages/contracts` because task 04a was scoped to
 * `apps/platform` and `packages/db-platform` while another agent was editing a neighbouring app,
 * and two agents rewriting one shared file is a silent clobber. Everything below is written in
 * the contracts style and against the contracts primitives, so moving it into
 * `packages/contracts/src/platform.ts` is a cut and a paste -- which is what task 08 should do
 * when it builds the console that consumes them. Recorded in decisions-made-overnight.md.
 */
import {
  entitlementsSchema,
  isoDateSchema,
  isoDateTimeSchema,
  slugSchema,
  tenantTierSchema,
  uuidSchema,
} from '@mercatus/contracts';
import { z } from 'zod';

/**
 * Creating a tenant directly, without a payment. Trials, internal demo stores and manually
 * onboarded merchants all need this, which is exactly why signup creates and payment activates
 * rather than one step doing both (Q13).
 */
export const createTenantBodySchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(120),
  tier: tenantTierSchema.default('pooled'),
});

/** The console's flip, and the manual activation, both answer the tenant they changed. */
export const activateTenantBodySchema = z
  .object({ validUntil: isoDateSchema.optional(), entitlements: entitlementsSchema.optional() })
  .default({});

/**
 * The signed licence (CG1, CC3). `licence` is a JWT: a data plane verifies it with the public key
 * from /licence/jwks and needs nothing else -- no database, no network, no control plane.
 */
export const signedLicenceSchema = z.object({
  licence: z.string().min(1),
  licenceId: uuidSchema,
  /** RFC 7638 thumbprint of the signing key. An unknown kid means "re-fetch the key set". */
  keyId: z.string().min(1),
  issuedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
});

/** A JWK set. Left loose on purpose -- it is JOSE's shape, not ours, and we only publish it. */
export const jwksSchema = z.object({ keys: z.array(z.record(z.string(), z.unknown())) });

/**
 * What the console shows about a registered box (CE6). Everything after `tenantSlug` is REPORTED
 * by a machine whose owner has root, so it is telemetry and never metering (CE3).
 */
export const installationSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  tenantSlug: slugSchema,
  version: z.string().nullable(),
  licenceId: uuidSchema.nullable(),
  productCount: z.number().int().nonnegative(),
  orderCount: z.number().int().nonnegative(),
  registeredAt: isoDateTimeSchema.nullable(),
  lastSeenAt: isoDateTimeSchema.nullable(),
});

export const installationListSchema = z.object({
  items: z.array(installationSchema),
  total: z.number().int().nonnegative(),
});

/** Registered only when AUTH_ADAPTER=stub, exactly like the store's dev login. */
export const devOperatorLoginBodySchema = z
  .object({ subject: z.string().min(1).max(120).default('dev-operator') })
  .default({ subject: 'dev-operator' });

export type CreateTenantBody = z.infer<typeof createTenantBodySchema>;
export type SignedLicenceResult = z.infer<typeof signedLicenceSchema>;
export type InstallationView = z.infer<typeof installationSchema>;
