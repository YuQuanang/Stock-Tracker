ALTER TABLE "settings" ALTER COLUMN "default_benchmark" SET DEFAULT 'VOO';--> statement-breakpoint
ALTER TABLE "price_bar" ADD COLUMN "adj_close" numeric(38, 12);