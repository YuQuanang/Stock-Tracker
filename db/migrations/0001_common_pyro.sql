ALTER TABLE "transaction" ADD COLUMN "price_as_of" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "price_status" text;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "fx_rate_to_sgd" numeric(38, 12);--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "fx_as_of" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "fx_source" text;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "total_cost_sgd" numeric(38, 12);--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "is_manual_price" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "is_manual_fx_rate" boolean DEFAULT false NOT NULL;