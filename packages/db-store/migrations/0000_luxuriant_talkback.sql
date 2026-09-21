CREATE TABLE "licence_state" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"entitlements" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"valid_until" date,
	"last_checked_at" timestamp with time zone,
	"last_success_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "order_counters" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"next_number" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"title_snapshot" text NOT NULL,
	"unit_price_minor" integer NOT NULL,
	"qty" integer NOT NULL,
	CONSTRAINT "order_lines_qty_positive" CHECK ("order_lines"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" bigint NOT NULL,
	"shopper_id" uuid NOT NULL,
	"status" text DEFAULT 'placed' NOT NULL,
	"total_minor" integer NOT NULL,
	"currency" text DEFAULT 'TRY' NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"title" text NOT NULL,
	"price_minor" integer NOT NULL,
	"currency" text DEFAULT 'TRY' NOT NULL,
	"image_url" text,
	"stock" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_price_minor_nonneg" CHECK ("products"."price_minor" >= 0),
	CONSTRAINT "products_stock_nonneg" CHECK ("products"."stock" >= 0)
);
--> statement-breakpoint
CREATE TABLE "shoppers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"phone" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"branding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_shopper_id_shoppers_id_fk" FOREIGN KEY ("shopper_id") REFERENCES "public"."shoppers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_tenant_number_uq" ON "orders" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "products_tenant_sku_uq" ON "products" USING btree ("tenant_id","sku");--> statement-breakpoint
CREATE UNIQUE INDEX "shoppers_tenant_phone_uq" ON "shoppers" USING btree ("tenant_id","phone");--> statement-breakpoint
CREATE UNIQUE INDEX "shoppers_tenant_subject_uq" ON "shoppers" USING btree ("tenant_id","subject");