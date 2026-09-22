/**
 * The data plane's contract (BUILD-PLAN §6.2). One image, two deployment modes, one set of
 * schemas -- a dedicated instance answers exactly these shapes as N=1 (CC1, CC2).
 *
 * Two surfaces, and the split is not cosmetic:
 *
 *   public / shopper -- tenant from the ROUTE, subject from the TOKEN, both always applied (BI2)
 *   staff            -- tenant from the TOKEN; a route that disagrees is a 403, not a switch (BI1)
 */
import { z } from 'zod';

import {
  currencySchema,
  healthSchema,
  isoDateSchema,
  isoDateTimeSchema,
  minorAmountSchema,
  pagedSchema,
  phoneSchema,
  quantitySchema,
  slugSchema,
  uuidSchema,
} from './common.js';

/* ------------------------------------------------------------------ entities */

/** Rendered as CSS custom properties by the storefront; a dedicated store is fully branded (DW). */
export const brandingSchema = z.object({
  logoUrl: z.url().optional(),
  accent: z.string().optional(),
  bg: z.string().optional(),
  fg: z.string().optional(),
});

export const storeBrandingSchema = brandingSchema.extend({
  name: z.string(),
  slug: slugSchema,
});

export const productSchema = z.object({
  id: uuidSchema,
  sku: z.string(),
  title: z.string(),
  priceMinor: minorAmountSchema,
  currency: currencySchema,
  imageUrl: z.url().nullable(),
  stock: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const orderLineSchema = z.object({
  id: uuidSchema,
  productId: uuidSchema,
  titleSnapshot: z.string(),
  unitPriceMinor: minorAmountSchema,
  qty: quantitySchema,
});

export const orderStatusSchema = z.enum(['placed', 'paid', 'cancelled']);

export const orderSchema = z.object({
  id: uuidSchema,
  /** Per-tenant and gapless. Tenant A's first order is 1 and so is tenant B's (BG2). */
  number: z.number().int().positive(),
  status: orderStatusSchema,
  totalMinor: minorAmountSchema,
  currency: currencySchema,
  placedAt: isoDateTimeSchema,
});

export const orderDetailSchema = orderSchema.extend({ lines: z.array(orderLineSchema) });

/**
 * `/health` on the data plane says more than `{ status, version }`: which of the two deployment
 * modes this process is running (CC1) and, when it is pinned to one tenant, which one. A build
 * that cannot tell you what it is fails CE6.
 */
export const storeHealthSchema = healthSchema.extend({
  mode: z.enum(['pooled', 'dedicated']),
  tenant: slugSchema.nullable(),
});

/* ------------------------------------------------- public / shopper surface */

/** Every public route is under `/t/:slug`. The slug is the tenant candidate, not the tenant. */
export const tenantSlugParamsSchema = z.object({ slug: slugSchema });
export const tenantResourceParamsSchema = tenantSlugParamsSchema.extend({ id: uuidSchema });

export const productListSchema = pagedSchema(productSchema);

export const checkoutBodySchema = z.object({
  lines: z.array(z.object({ productId: uuidSchema, qty: quantitySchema })).min(1),
  shopper: z.object({ phone: phoneSchema, name: z.string().min(1).max(120).optional() }),
});

export const checkoutResultSchema = z.object({
  orderId: uuidSchema,
  number: z.number().int().positive(),
  totalMinor: minorAmountSchema,
  currency: currencySchema,
});

export const orderListSchema = pagedSchema(orderSchema);

/* --------------------------------------------------------------- staff surface */

export const createProductBodySchema = z.object({
  sku: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  priceMinor: minorAmountSchema,
  currency: currencySchema.optional(),
  imageUrl: z.url().nullable().optional(),
  stock: z.number().int().nonnegative(),
});

/** Any subset of the above. `.strict()` so a typo is a 400 rather than a silent no-op. */
export const patchProductBodySchema = createProductBodySchema.partial().strict();

export const idParamsSchema = z.object({ id: uuidSchema });

/** What a DELETE answers. One shape, so no route invents `{ ok: true }` on its own. */
export const deleteResultSchema = z.object({ deleted: z.literal(true) });

export const settingsSchema = z.object({
  name: z.string(),
  slug: slugSchema,
  branding: brandingSchema,
});

export const patchSettingsBodySchema = z
  .object({ name: z.string().min(1).max(120), branding: brandingSchema })
  .partial()
  .strict();

/* --------------------------------------------------- licence and degradation */

/** The tenant's own state. `passive` blocks checkout and leaves the dashboard usable (CG3, ES). */
export const licenceStatusSchema = z.enum(['active', 'passive']);

/**
 * How the store is currently behaving. `passive` is the merchant's problem; `grace` and
 * `read_only` are OURS, and the three are never collapsed into one flag (CG3).
 */
export const licenceRuntimeStateSchema = z.enum(['healthy', 'passive', 'grace', 'read_only']);

export const licenceViewSchema = z.object({
  status: licenceStatusSchema,
  state: licenceRuntimeStateSchema,
  entitlements: z.record(z.string(), z.boolean()),
  validUntil: isoDateSchema.nullable(),
  lastCheckedAt: isoDateTimeSchema.nullable(),
  /** The grace window is measured from here, not from lastCheckedAt (CG2). */
  lastSuccessAt: isoDateTimeSchema.nullable(),
});

/** What the degradation demo curls. */
export const storeMetaSchema = z.object({
  mode: z.enum(['pooled', 'dedicated']),
  version: z.string(),
  tenantCount: z.number().int().nonnegative(),
  licence: licenceViewSchema.pick({ status: true, state: true, lastSuccessAt: true }),
});

/* ------------------------------------------------------------------ dev login */

/** Registered only when AUTH_ADAPTER=stub. The Identity phase deletes these two routes. */
export const devStaffLoginBodySchema = z.object({
  slug: slugSchema,
  role: z.enum(['owner', 'staff']).default('owner'),
});

export const devShopperLoginBodySchema = z.object({ phone: phoneSchema });

export const devLoginResultSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresAt: z.number().int().positive(),
});

/* ---------------------------------------------------------------------- session */

/**
 * The store's OWN session (task 08). After the OIDC round trip the browser holds a cookie this
 * store signed, and every request after that is checked locally -- which is what keeps a
 * dedicated instance selling while the control plane is down (README Q20).
 */
export const sessionInfoSchema = z.object({
  kind: z.enum(['staff', 'shopper']),
  subject: z.string(),
  /** Always null for a shopper: a shopper session is tenant-less on purpose (BI2). */
  tenantId: z.uuid().nullable(),
  roles: z.array(z.enum(['owner', 'staff'])),
  expiresAt: z.number().int().positive(),
  /** Which adapter authenticated this person -- `stub` until the Identity phase lands. */
  issuedBy: z.enum(['stub', 'oidc']),
});

export const startLoginQuerySchema = z.object({
  audience: z.enum(['staff', 'shopper']).default('staff'),
  /** Selects the organization for a staff login; ignored for shoppers. */
  slug: slugSchema.optional(),
  /** Where to send the browser once the session cookie is set. Must be a relative path. */
  next: z.string().startsWith('/').default('/'),
});

export const loginCallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

/* ------------------------------------------------------------------- inferred */

export type Branding = z.infer<typeof brandingSchema>;
export type StoreBranding = z.infer<typeof storeBrandingSchema>;
export type Product = z.infer<typeof productSchema>;
export type ProductList = z.infer<typeof productListSchema>;
export type CreateProductBody = z.infer<typeof createProductBodySchema>;
export type PatchProductBody = z.infer<typeof patchProductBodySchema>;
export type Order = z.infer<typeof orderSchema>;
export type OrderLine = z.infer<typeof orderLineSchema>;
export type OrderDetail = z.infer<typeof orderDetailSchema>;
export type OrderList = z.infer<typeof orderListSchema>;
export type CheckoutBody = z.infer<typeof checkoutBodySchema>;
export type CheckoutResult = z.infer<typeof checkoutResultSchema>;
export type DeleteResult = z.infer<typeof deleteResultSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type PatchSettingsBody = z.infer<typeof patchSettingsBodySchema>;
export type LicenceStatus = z.infer<typeof licenceStatusSchema>;
export type LicenceRuntimeState = z.infer<typeof licenceRuntimeStateSchema>;
export type LicenceView = z.infer<typeof licenceViewSchema>;
export type StoreMeta = z.infer<typeof storeMetaSchema>;
export type StoreHealth = z.infer<typeof storeHealthSchema>;
export type DevLoginResult = z.infer<typeof devLoginResultSchema>;
export type SessionInfo = z.infer<typeof sessionInfoSchema>;
export type StartLoginQuery = z.infer<typeof startLoginQuerySchema>;
export type LoginCallbackQuery = z.infer<typeof loginCallbackQuerySchema>;
