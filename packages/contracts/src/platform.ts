/**
 * The control plane's contract (BUILD-PLAN §6.1).
 *
 * CH1 applies to everything in this file: "backward compatibility is not a requirement" is the
 * repo's policy INSIDE the data plane, where everything ships together. These shapes are spoken
 * by a dedicated instance running on someone else's server, on a version we do not control, so
 * they keep a compatibility window instead.
 */
import { z } from 'zod';

import {
  currencySchema,
  isoDateSchema,
  isoDateTimeSchema,
  minorAmountSchema,
  pagedSchema,
  phoneSchema,
  slugSchema,
  uuidSchema,
} from './common.js';
import { licenceStatusSchema } from './store.js';

/* ------------------------------------------------------------------ entities */

/** Signup creates the tenant as `pending`; payment activates it (Q13). */
export const tenantStatusSchema = z.enum(['pending', 'active', 'passive']);

/** Tier 1 pooled and tier 3 dedicated. Tier 2 is designed, not built (DP). */
export const tenantTierSchema = z.enum(['pooled', 'dedicated']);

export const membershipRoleSchema = z.enum(['owner', 'staff']);

export const entitlementsSchema = z.record(z.string(), z.boolean());

export const tenantSchema = z.object({
  id: uuidSchema,
  slug: slugSchema,
  name: z.string(),
  status: tenantStatusSchema,
  tier: tenantTierSchema,
  createdAt: isoDateTimeSchema,
  activatedAt: isoDateTimeSchema.nullable(),
});

/**
 * The console's row. `lastSeenAt` and the counts come from a dedicated instance's heartbeat and
 * are telemetry, never metering (CE3, CJ1) -- the customer has root on that box.
 */
export const tenantSummarySchema = tenantSchema.extend({
  licence: z
    .object({
      status: licenceStatusSchema,
      entitlements: entitlementsSchema,
      validUntil: isoDateSchema,
    })
    .nullable(),
  installation: z
    .object({
      id: uuidSchema,
      version: z.string().nullable(),
      lastSeenAt: isoDateTimeSchema.nullable(),
      productCount: z.number().int().nonnegative(),
      orderCount: z.number().int().nonnegative(),
    })
    .nullable(),
});

export const tenantListSchema = pagedSchema(tenantSummarySchema);

/* --------------------------------------------------------- buy a store (Q13) */

export const signupBodySchema = z.object({
  phone: phoneSchema,
  name: z.string().min(1).max(120),
  storeName: z.string().min(1).max(120),
  slug: slugSchema,
  tier: tenantTierSchema.default('pooled'),
});

export const signupResultSchema = z.object({
  tenantId: uuidSchema,
  slug: slugSchema,
  /** fake-bank's hosted page. Signup creates, payment activates. */
  paymentUrl: z.url(),
});

export const paymentStatusSchema = z.enum(['created', 'paid', 'declined']);

/**
 * fake-bank's signed callback. The signature is verified before anything is written, and the
 * whole endpoint is idempotent by `providerRef` -- the callback can and will arrive twice (CK2).
 */
export const paymentCallbackBodySchema = z.object({
  providerRef: z.string().min(1),
  status: paymentStatusSchema,
  amountMinor: minorAmountSchema,
  currency: currencySchema,
  signature: z.string().min(1),
});

/**
 * A dedicated plane's checkout payment, proxied. Our merchant credentials stay in the control
 * plane; their server never holds a key that bills us (CE2).
 */
export const paymentProxyBodySchema = z.object({
  tenantId: uuidSchema,
  amountMinor: minorAmountSchema,
  currency: currencySchema,
  reference: z.string().min(1),
});

export const paymentSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  providerRef: z.string(),
  amountMinor: minorAmountSchema,
  currency: currencySchema,
  status: paymentStatusSchema,
  createdAt: isoDateTimeSchema,
  settledAt: isoDateTimeSchema.nullable(),
});

/* ------------------------------------------------------------------ licences */

/** The console's flip (ES). Passive blocks the money-making action and nothing else. */
export const setLicenceBodySchema = z.object({
  status: licenceStatusSchema,
  validUntil: isoDateSchema.optional(),
  entitlements: entitlementsSchema.optional(),
});

/**
 * What a data plane polls for (CE4: it pulls, we never push). `serverTime` is included so the
 * instance can measure its own grace window against our clock rather than its own.
 */
export const licencePollResultSchema = z.object({
  status: licenceStatusSchema,
  entitlements: entitlementsSchema,
  validUntil: isoDateSchema.nullable(),
  serverTime: isoDateTimeSchema,
});

/* ------------------------------------------------------------- installations */

export const createInstallationBodySchema = z.object({ tenantSlug: slugSchema });

/** `bootstrapToken` is shown exactly once and stored only as a hash. */
export const createInstallationResultSchema = z.object({
  installationId: uuidSchema,
  bootstrapToken: z.string().min(32),
});

export const registerInstallationBodySchema = z.object({
  bootstrapToken: z.string().min(32),
  version: z.string().min(1),
});

/** Per-instance and individually revocable (CE1). Burns the bootstrap token. */
export const registerInstallationResultSchema = z.object({
  installationId: uuidSchema,
  instanceToken: z.string().min(32),
  tenantId: uuidSchema,
  tenantSlug: slugSchema,
});

/**
 * The heartbeat (CE6): every data plane reports what it is on every batch, because version skew
 * is invisible until you can query it. Scrubbed at source -- no shopper ever appears here (CI1).
 */
export const heartbeatBodySchema = z.object({
  version: z.string().min(1),
  tenantId: uuidSchema,
  licenceId: uuidSchema.nullable(),
  productCount: z.number().int().nonnegative(),
  orderCount: z.number().int().nonnegative(),
});

/* ------------------------------------------------------------------- inferred */

export type TenantStatus = z.infer<typeof tenantStatusSchema>;
export type TenantTier = z.infer<typeof tenantTierSchema>;
export type MembershipRole = z.infer<typeof membershipRoleSchema>;
export type Tenant = z.infer<typeof tenantSchema>;
export type TenantSummary = z.infer<typeof tenantSummarySchema>;
export type TenantList = z.infer<typeof tenantListSchema>;
export type SignupBody = z.infer<typeof signupBodySchema>;
export type SignupResult = z.infer<typeof signupResultSchema>;
export type PaymentCallbackBody = z.infer<typeof paymentCallbackBodySchema>;
export type PaymentProxyBody = z.infer<typeof paymentProxyBodySchema>;
export type Payment = z.infer<typeof paymentSchema>;
export type SetLicenceBody = z.infer<typeof setLicenceBodySchema>;
export type LicencePollResult = z.infer<typeof licencePollResultSchema>;
export type CreateInstallationBody = z.infer<typeof createInstallationBodySchema>;
export type CreateInstallationResult = z.infer<typeof createInstallationResultSchema>;
export type RegisterInstallationBody = z.infer<typeof registerInstallationBodySchema>;
export type RegisterInstallationResult = z.infer<typeof registerInstallationResultSchema>;
export type HeartbeatBody = z.infer<typeof heartbeatBodySchema>;
