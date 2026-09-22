/**
 * What the console expects back from the control plane, as Zod schemas.
 *
 * WHY THESE ARE NOT IMPORTED FROM @mercatus/contracts, which is where the same shapes already
 * live: `@mercatus/contracts` imports `@mercatus/core` for its paging constants, and core's
 * barrel re-exports `http/server.js`, which imports Fastify. Pulling that into a browser bundle
 * would mean Vite resolving `node:async_hooks` and half of Fastify for two integers. The fix is
 * to split contracts from core's server half; that is a change to packages/, and task 07c was
 * scoped to apps/admin with two other agents in the tree. Recorded in
 * docs/decisions-made-overnight.md.
 *
 * They are still PARSED rather than cast. An `as TenantSummary` would make a control-plane change
 * show up as a blank cell three screens later; a parse failure names the field.
 */
import { z } from 'zod';

export const tenantStatusSchema = z.enum(['pending', 'active', 'passive']);
export const tenantTierSchema = z.enum(['pooled', 'dedicated']);
export const licenceStatusSchema = z.enum(['active', 'passive']);

/** Everything a dedicated box reports is telemetry, never metering -- its owner has root (CE3). */
const installationSummarySchema = z.object({
  id: z.uuid(),
  version: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  productCount: z.number().int().nonnegative(),
  orderCount: z.number().int().nonnegative(),
});

export const tenantSummarySchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  status: tenantStatusSchema,
  tier: tenantTierSchema,
  createdAt: z.string(),
  activatedAt: z.string().nullable(),
  licence: z
    .object({
      status: licenceStatusSchema,
      entitlements: z.record(z.string(), z.boolean()),
      validUntil: z.string(),
    })
    .nullable(),
  installation: installationSummarySchema.nullable(),
});

export const tenantListSchema = z.object({
  items: z.array(tenantSummarySchema),
  total: z.number().int().nonnegative(),
});

/** `GET /installations` -- registered boxes and what they last said (CE6). */
export const installationSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  tenantSlug: z.string(),
  version: z.string().nullable(),
  licenceId: z.uuid().nullable(),
  productCount: z.number().int().nonnegative(),
  orderCount: z.number().int().nonnegative(),
  registeredAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
});

export const installationListSchema = z.object({
  items: z.array(installationSchema),
  total: z.number().int().nonnegative(),
});

export const devLoginResultSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.number().int(),
});

/** The one error envelope every non-2xx in this repo carries (BUILD-PLAN §6.0). */
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type TenantStatus = z.infer<typeof tenantStatusSchema>;
export type TenantTier = z.infer<typeof tenantTierSchema>;
export type LicenceStatus = z.infer<typeof licenceStatusSchema>;
export type TenantSummary = z.infer<typeof tenantSummarySchema>;
export type Installation = z.infer<typeof installationSchema>;
