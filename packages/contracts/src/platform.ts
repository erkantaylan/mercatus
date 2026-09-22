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
  /**
   * Which licence these facts came from. The data plane does not store it -- it reports it back
   * on the same tick's heartbeat, which is how a version-and-licence skew becomes queryable
   * rather than a thing somebody has to ssh in and look at (CE6). Null while a tenant is still
   * pending and has no licence to name.
   */
  licenceId: uuidSchema.nullable(),
});

/* ------------------------------------------------------------- installations */

/**
 * A hostname, no scheme, no port, no path. It is what the instance's `baseUrl` is PINNED to at
 * registration (`GK`, `S1`): a stolen bootstrap token must not be spendable into
 * `evil.com/auth/callback`, because the platform turns the registered baseUrl into a Logto
 * redirect URI and an attacker-controlled redirect URI harvests that tenant's authorization
 * codes. The PORT is deliberately not pinned -- a dedicated instance's port is assigned by its
 * own orchestrator and cannot be known when the token is minted, which is the whole point of
 * opt-in registration.
 */
export const hostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/, 'must be a bare hostname')
  .transform((h) => h.toLowerCase());

export const createInstallationBodySchema = z.object({
  tenantSlug: slugSchema,
  /** The only host this installation may ever register itself at. See `hostSchema`. */
  expectedHost: hostSchema,
});

/** `bootstrapToken` is shown exactly once and stored only as a hash. */
export const createInstallationResultSchema = z.object({
  installationId: uuidSchema,
  bootstrapToken: z.string().min(32),
});

/**
 * The instance says WHERE IT LIVES. That sentence is the whole of v2.0.0: before it, the control
 * plane had to be told a dedicated store's address before that store existed, which is what
 * forced `MERCATUS_STORE_DEDICATED_PORT` to be a fixed number in two application models.
 *
 * Every URL here is host-checked against the installation's `expectedHost` before the bootstrap
 * token is spent, and each one becomes a redirect URI at the issuer.
 */
export const registerInstallationBodySchema = z.object({
  bootstrapToken: z.string().min(32),
  version: z.string().min(1),
  /** The store API's own public base, e.g. `http://localhost:41234`. `/auth/callback` hangs off it. */
  baseUrl: z.url(),
  /** The merchant dashboard shipped beside it. `/callback` hangs off it. */
  dashboardUrl: z.url().optional(),
  /** The storefront shipped beside it. `/api/auth/callback` hangs off it. */
  storefrontUrl: z.url().optional(),
});

/**
 * What the issuer knows about THIS instance, minted at registration and per-instance (CE1): its
 * own Logto application, not a client shared with the pooled plane. `organizationId` is this
 * tenant's Logto organization and nobody else's -- a box somebody else owns has no business
 * holding the directory of every tenant we have.
 *
 * Null when the control plane has no Management API credential wired up; the instance then keeps
 * whatever identity configuration it already had, which is what `AUTH_ADAPTER=stub` runs on.
 */
export const instanceOidcSchema = z.object({
  issuer: z.url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  organizationId: z.string().min(1).nullable(),
});

/** Per-instance and individually revocable (CE1). Burns the bootstrap token. */
export const registerInstallationResultSchema = z.object({
  installationId: uuidSchema,
  instanceToken: z.string().min(32),
  tenantId: uuidSchema,
  tenantSlug: slugSchema,
  /** Configured BY THE ANSWER, not by environment. Null when identity is not wired up. */
  oidc: instanceOidcSchema.nullable(),
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
export type InstanceOidc = z.infer<typeof instanceOidcSchema>;
export type HeartbeatBody = z.infer<typeof heartbeatBodySchema>;
