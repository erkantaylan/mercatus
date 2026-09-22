ALTER TABLE "installations" ADD COLUMN "licence_id" uuid;--> statement-breakpoint
ALTER TABLE "licences" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "licences" ADD CONSTRAINT "licences_id_unique" UNIQUE("id");