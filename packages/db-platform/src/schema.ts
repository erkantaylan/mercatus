/**
 * Control-plane schema (BUILD-PLAN §5.1), database `platform`.
 *
 * No RLS here, and that is not an oversight: this database has exactly one tenant, which is us.
 * The isolation rules in §3 are about the DATA plane, where N merchants share tables. Adding
 * policies here would be ceremony with no failure behind it.
 *
 * `tenants.id` is minted HERE and mirrored outward (BV1). It is never an external system's key:
 * the Stripe-subscription-id-as-tenant-id mistake means a customer who cancels and resubscribes
 * comes back as a different tenant and loses their data. `payment_ref` is where the external
 * identifier lives -- an attribute, not a key.
 */
import { sql } from 'drizzle-orm';
import {
  date,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export type TenantStatus = 'pending' | 'active' | 'passive';
export type TenantTier = 'pooled' | 'dedicated';
export type MembershipRole = 'owner' | 'staff';
export type PaymentStatus = 'created' | 'paid' | 'declined';
export type Entitlements = Record<string, boolean>;

/** A person. May work for several merchants -- see `memberships` (BA1). */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** The login identity. Phone + OTP, so this is what the IdP keys on. */
  phone: text('phone').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A tenant is a store (Q9). Flat: no chains, no groups, no tenant-of-tenants (ET). */
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** What appears in URLs. A slug for URLs, a uuid for the key (BV3). */
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  /** Signup creates `pending`; the payment callback activates (Q13). `passive` is the flip (ES). */
  status: text('status').$type<TenantStatus>().notNull().default('pending'),
  tier: text('tier').$type<TenantTier>().notNull().default('pooled'),
  /** fake-bank's reference. An attribute, never the key (BV1). */
  paymentRef: text('payment_ref'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
});

/**
 * (user_id, tenant_id, role) from day one (BA1). Taking "the first matching group" cannot express
 * a person who works for two merchants, and retrofitting that is a migration across every table.
 */
export const memberships = pgTable(
  'memberships',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    role: text('role').$type<MembershipRole>().notNull().default('staff'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.tenantId] })],
);

/** One licence per tenant. Features gate on `entitlements`, never on a build (CC3). */
export const licences = pgTable('licences', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  entitlements: jsonb('entitlements').$type<Entitlements>().notNull().default(sql`'{}'::jsonb`),
  validUntil: date('valid_until').notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A dedicated instance that registered itself (CE7). It registers, pulls config, pulls updates
 * and pushes telemetry -- we never open a connection into their network (CE4).
 *
 * Tokens are stored as sha256 hashes: the bootstrap token is shown once and nulled on first use,
 * and the instance token is per-instance and individually revocable (CE1). One leaked key on one
 * merchant's VPS must not be a platform-wide incident.
 *
 * `version`, `product_count` and `order_count` are REPORTED. They are telemetry, not metering
 * (CE3, CJ1) -- the customer has root on that box and can edit the numbers. Limits are enforced
 * through the signed licence, never from these.
 */
export const installations = pgTable('installations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  bootstrapTokenHash: text('bootstrap_token_hash'),
  instanceTokenHash: text('instance_token_hash'),
  version: text('version'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  productCount: integer('product_count').notNull().default(0),
  orderCount: integer('order_count').notNull().default(0),
  registeredAt: timestamp('registered_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Buying a store. Idempotent by `provider_ref`, because the callback may arrive twice (CK2). */
export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  providerRef: text('provider_ref').notNull().unique(),
  amountMinor: integer('amount_minor').notNull(),
  currency: text('currency').notNull().default('TRY'),
  status: text('status').$type<PaymentStatus>().notNull().default('created'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
});

export type UserRow = typeof users.$inferSelect;
export type TenantRow = typeof tenants.$inferSelect;
export type MembershipRow = typeof memberships.$inferSelect;
export type LicenceRow = typeof licences.$inferSelect;
export type InstallationRow = typeof installations.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;

/**
 * No `domains` table: tier 2 is out of the POC (DP). The seam that keeps it an addition rather
 * than a retrofit is tenant resolution taking a REQUEST rather than a route parameter
 * (core/tenant/resolve.ts, §3.6), not a table here.
 */
