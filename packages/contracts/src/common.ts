/**
 * The primitives every other schema is built from (BUILD-PLAN §6.0).
 *
 * The schema IS the contract: there is no hand-written type beside it, and no route validates by
 * hand. Anything that appears in two endpoints appears once here.
 */
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@mercatus/core';
import { z } from 'zod';

/** A tenant id, a product id, an order id. Always a uuid, never an external system's key (BV1). */
export const uuidSchema = z.uuid();

/**
 * What appears in URLs (BV3). Lowercase, hyphenated, no leading or trailing hyphen -- and
 * deliberately not the tenant id, which stays a uuid and stays out of public surface.
 */
export const slugSchema = z
  .string()
  .min(2)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Lowercase letters, digits and hyphens.');

/** E.164. The login identity for staff and the shopper's contact on an order. */
export const phoneSchema = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, 'A phone number in E.164 form, e.g. +905550000000.');

/** ISO 4217, three letters. A separate column from the amount, never baked into it. */
export const currencySchema = z.string().length(3).regex(/^[A-Z]{3}$/);

/**
 * Money, always an integer in minor units. Never a float and never `numeric`: a POC that does not
 * need decimals should not carry a rounding-bug class to prove it.
 */
export const minorAmountSchema = z.number().int().nonnegative();

export const quantitySchema = z.number().int().positive();

/** Date only, `YYYY-MM-DD`. Licence validity is a date, not an instant. */
export const isoDateSchema = z.iso.date();

/** An instant, serialised as ISO 8601. Every timestamp on the wire is one of these. */
export const isoDateTimeSchema = z.iso.datetime({ offset: true });

/**
 * Limit and offset, clamped rather than rejected -- the same rule as core's normalisePageRequest.
 * A client asking for 10 000 rows is being optimistic, not hostile, and a 400 there buys nothing.
 */
export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

/** Every list endpoint, everywhere: `{ items, total }`. No cursors (§6.0). */
export function pagedSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), total: z.number().int().nonnegative() });
}

export const healthSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
});

export type Health = z.infer<typeof healthSchema>;
