ALTER TABLE "instrument" ADD COLUMN "price_not_found_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "instrument" ADD COLUMN "price_not_found_reason" text;