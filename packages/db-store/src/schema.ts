/**
 * Data-plane schema (BUILD-PLAN §5.2). Identical in pooled and dedicated deployments -- the
 * dedicated plane runs this as N=1, with the same columns and the same policies (CC2). A second
 * schema for single-tenant installs is a second test matrix and the first source of
 * "works pooled, breaks dedicated".
 *
 * Every table here except `tenants` carries `tenant_id` and is protected by RLS (sql/02-rls.sql).
 * Every uniqueness constraint is composite with `tenant_id` (BG1): a global unique constraint is
 * an assumption inherited from a single-tenant schema, and it is wrong now.
 *
 * Money is an integer in minor units with a separate `currency` column. Never a float, never
 * numeric (decisions-made-overnight.md, task 00).
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Branding blob on `tenants`, rendered as CSS custom properties by the storefront (DW). */
export interface Branding {
  readonly logoUrl?: string;
  readonly accent?: string;
  readonly bg?: string;
  readonly fg?: string;
}

/** Entitlements blob on `licence_state`. Features gate on this, never on a build (CC3). */
export type Entitlements = Record<string, boolean>;

/**
 * The one data-plane table WITHOUT row level security.
 *
 * It is the lookup that establishes tenant context: a policy on it would require the context it
 * is being read to produce. `mercatus_app` is granted `select` only -- the rows are mirrored from
 * the control plane, never minted here (BV1), so the data plane has nothing to write.
 *
 * `slug` is globally unique on purpose. BG1 is about tenant-scoped tables; this IS the tenant
 * table, and a slug is the URL identity of a store (BV3).
 */
export const tenants = pgTable('tenants', {
  /** uuid minted by the control plane and mirrored here. Not defaulted: we never invent one. */
  id: uuid('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  branding: jsonb('branding').$type<Branding>().notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * What this store believes about its own licence (CG3). `status` is the tenant's own state and
 * blocks checkout; `last_success_at` is ours and drives the grace window. The two are separate
 * columns because collapsing them makes our outage look to the merchant exactly like being cut
 * off for non-payment.
 */
export const licenceState = pgTable('licence_state', {
  tenantId: uuid('tenant_id').primaryKey(),
  status: text('status').$type<'active' | 'passive'>().notNull().default('active'),
  entitlements: jsonb('entitlements').$type<Entitlements>().notNull().default(sql`'{}'::jsonb`),
  validUntil: date('valid_until'),
  /** Last poll attempt, successful or not. */
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  /** Last poll that actually reached the control plane. The grace window is measured from here. */
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  /**
   * The FIRST poll attempt this instance ever made, successful or not. Never cleared.
   *
   * It exists because "never succeeded" and "not configured to poll" are different states and
   * were being collapsed into one: an instance whose credential the control plane rejects polls,
   * is refused on every tick, and used to keep reporting `healthy` for ever with `last_success_at`
   * null -- selling the whole time. Grace is EARNED by a success (CG1, CG2); an instance that has
   * never authenticated has earned none, so once this is older than a few poll intervals it is
   * read_only rather than healthy.
   */
  pollingSince: timestamp('polling_since', { withTimezone: true }),
});

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    sku: text('sku').notNull(),
    title: text('title').notNull(),
    priceMinor: integer('price_minor').notNull(),
    currency: text('currency').notNull().default('TRY'),
    imageUrl: text('image_url'),
    stock: integer('stock').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // BG1: composite with tenant_id. Two merchants may both sell SKU "A-1".
    uniqueIndex('products_tenant_sku_uq').on(t.tenantId, t.sku),
    // Not redundant with the primary key. It is the target a TENANT-CONSISTENT foreign key needs
    // (OPEN-DEFECTS F1): postgres runs referential-integrity checks with row security OFF, so a
    // child pointing at `products (id)` alone can name ANOTHER tenant's product and the policy
    // never sees it. Referencing `(id, tenant_id)` makes the parent's tenant part of the check.
    unique('products_id_tenant_uq').on(t.id, t.tenantId),
    check('products_price_minor_nonneg', sql`${t.priceMinor} >= 0`),
    check('products_stock_nonneg', sql`${t.stock} >= 0`),
  ],
);

/**
 * A shopper is a row in a store, not a user of the platform (CD3). `subject` is the token `sub`
 * and is the second half of every shopper query (BI2): tenant from the route, subject from the
 * token, both conditions always applied -- except that here the tenant half is RLS's job.
 */
export const shoppers = pgTable(
  'shoppers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    subject: text('subject').notNull(),
    phone: text('phone').notNull(),
    name: text('name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('shoppers_tenant_phone_uq').on(t.tenantId, t.phone),
    uniqueIndex('shoppers_tenant_subject_uq').on(t.tenantId, t.subject),
    /** The tenant-consistent FK target for `orders.shopper_id` (F1). See `products`. */
    unique('shoppers_id_tenant_uq').on(t.id, t.tenantId),
  ],
);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    /** Per-tenant and gapless, from order_counters (BG2). Never a Postgres sequence. */
    number: bigint('number', { mode: 'number' }).notNull(),
    /** FK is composite, in the table extras below: a single-column one crosses tenants (F1). */
    shopperId: uuid('shopper_id').notNull(),
    status: text('status').$type<'placed' | 'paid' | 'cancelled'>().notNull().default('placed'),
    /**
     * Did this order get paid? The one question a merchant dashboard exists to answer, and it
     * used to live only in the storefront process's memory -- lost on restart, never in any
     * database, never shown to the merchant. The bank is the authority; this is what it said.
     */
    paymentStatus: text('payment_status')
      .$type<'unpaid' | 'paid' | 'declined'>()
      .notNull()
      .default('unpaid'),
    /** `fb_<uuid>` -- the provider's own reference, so a bank record is findable from an order. */
    paymentRef: text('payment_ref'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    totalMinor: integer('total_minor').notNull(),
    currency: text('currency').notNull().default('TRY'),
    placedAt: timestamp('placed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('orders_tenant_number_uq').on(t.tenantId, t.number),
    unique('orders_id_tenant_uq').on(t.id, t.tenantId),
    /**
     * TENANT-CONSISTENT (F1). `orders.shopper_id -> shoppers.id` alone let one tenant's order
     * name another tenant's shopper row: the RI check runs with row security off, so `with check`
     * validated the order's own tenant_id and never its parent's.
     */
    foreignKey({
      columns: [t.shopperId, t.tenantId],
      foreignColumns: [shoppers.id, shoppers.tenantId],
      name: 'orders_shopper_tenant_fk',
    }),
  ],
);

/**
 * Carries `tenant_id` even though it could be reached through `orders`. BE4 is about checking
 * each store separately: a policy on the parent is not a policy on the child, and a join is not
 * a guarantee.
 *
 * `title_snapshot` and `unit_price_minor` are the values at order time. An order does not change
 * because a product was later renamed or repriced.
 */
export const orderLines = pgTable(
  'order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    orderId: uuid('order_id').notNull(),
    productId: uuid('product_id').notNull(),
    titleSnapshot: text('title_snapshot').notNull(),
    unitPriceMinor: integer('unit_price_minor').notNull(),
    qty: integer('qty').notNull(),
  },
  (t) => [
    check('order_lines_qty_positive', sql`${t.qty} > 0`),
    /**
     * The defect this schema shipped with, and the fix (OPEN-DEFECTS F1).
     *
     * Single-column FKs here were a CROSS-TENANT DENIAL OF SERVICE costing one INSERT: tenant B
     * inserted an order_line carrying B's tenant_id -- which `with check` accepts, it is B's own
     * row -- pointing at tenant A's order and A's product. A could then never delete that order
     * or that product again ("violates foreign key constraint"), could not see the planted row,
     * and had no way to remove it. Referential integrity is checked with row security OFF; the
     * only fix is to put the tenant INSIDE the constraint.
     */
    foreignKey({
      columns: [t.orderId, t.tenantId],
      foreignColumns: [orders.id, orders.tenantId],
      name: 'order_lines_order_tenant_fk',
    }),
    foreignKey({
      columns: [t.productId, t.tenantId],
      foreignColumns: [products.id, products.tenantId],
      name: 'order_lines_product_tenant_fk',
    }),
  ],
);

/**
 * One row per tenant (BG2). Taken inside the order transaction with
 * `select next_number from order_counters for update` -- and with NO where clause, because RLS
 * is what scopes it (§3.5).
 *
 * Not a sequence: a sequence does not roll back, so numbering would be neither per-tenant nor
 * gapless, and every merchant expects their first order to be number 1.
 */
export const orderCounters = pgTable('order_counters', {
  tenantId: uuid('tenant_id').primaryKey(),
  nextNumber: bigint('next_number', { mode: 'number' }).notNull().default(1),
});

export type TenantRow = typeof tenants.$inferSelect;
export type LicenceStateRow = typeof licenceState.$inferSelect;
export type ProductRow = typeof products.$inferSelect;
export type ShopperRow = typeof shoppers.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;
export type OrderLineRow = typeof orderLines.$inferSelect;

/**
 * Every RLS-protected table, in one place. The leak suite (BL1) iterates this, so a table added
 * to the schema without being added here is a table the suite silently stops covering -- keep
 * them together.
 */
export const RLS_TABLES = [
  'licence_state',
  'products',
  'shoppers',
  'orders',
  'order_lines',
  'order_counters',
] as const;

export type RlsTable = (typeof RLS_TABLES)[number];
