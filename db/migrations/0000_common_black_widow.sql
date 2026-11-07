CREATE TYPE "public"."asset_type" AS ENUM('stock', 'etf', 'reit', 'index', 'crypto', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."dividend_mode" AS ENUM('cash', 'shares');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('committed', 'undone');--> statement-breakpoint
CREATE TYPE "public"."portfolio_type" AS ENUM('holdings', 'watchlist');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('Buy', 'Sell', 'Sell All', 'Dividend');--> statement-breakpoint
CREATE TABLE "corporate_action" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"ex_date" date NOT NULL,
	"type" text DEFAULT 'split' NOT NULL,
	"ratio_numerator" integer NOT NULL,
	"ratio_denominator" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "csv_import_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"filename" text NOT NULL,
	"status" "import_status" DEFAULT 'committed' NOT NULL,
	"row_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fx_rate" (
	"date" date NOT NULL,
	"from_currency" text NOT NULL,
	"to_currency" text NOT NULL,
	"rate" numeric(20, 10) NOT NULL,
	"source" text DEFAULT 'frankfurter' NOT NULL,
	CONSTRAINT "fx_rate_date_from_currency_to_currency_pk" PRIMARY KEY("date","from_currency","to_currency")
);
--> statement-breakpoint
CREATE TABLE "instrument" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" text NOT NULL,
	"name" text,
	"import_name" text,
	"import_display_symbol" text,
	"exchange_code" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"asset_type" "asset_type" DEFAULT 'unknown' NOT NULL,
	"manual_price" numeric(38, 12),
	"is_delisted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"succeeded" boolean NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "portfolio_type" DEFAULT 'holdings' NOT NULL,
	"default_currency" text DEFAULT 'USD' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by_import_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_instrument" (
	"portfolio_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"date_added" timestamp with time zone DEFAULT now() NOT NULL,
	"price_when_added" numeric(38, 12),
	"alert_above" numeric(38, 12),
	"alert_below" numeric(38, 12),
	"paper_entry_date" date,
	"paper_amount" numeric(38, 12),
	"paper_shares" numeric(38, 12),
	"created_by_import_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portfolio_instrument_portfolio_id_instrument_id_pk" PRIMARY KEY("portfolio_id","instrument_id")
);
--> statement-breakpoint
CREATE TABLE "price_bar" (
	"instrument_id" uuid NOT NULL,
	"date" date NOT NULL,
	"open" numeric(38, 12),
	"high" numeric(38, 12),
	"low" numeric(38, 12),
	"close" numeric(38, 12) NOT NULL,
	"volume" numeric(38, 12),
	"source" text DEFAULT 'unknown' NOT NULL,
	CONSTRAINT "price_bar_instrument_id_date_pk" PRIMARY KEY("instrument_id","date")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"base_currency" text DEFAULT 'SGD' NOT NULL,
	"risk_free_rate" numeric(8, 6) DEFAULT '0.035' NOT NULL,
	"default_benchmark" text DEFAULT '^GSPC' NOT NULL,
	"cost_basis_method" text DEFAULT 'FIFO' NOT NULL,
	"dividend_mode" "dividend_mode" DEFAULT 'cash' NOT NULL,
	"theme" text DEFAULT 'system' NOT NULL,
	"gain_color_scheme" text DEFAULT 'green-up' NOT NULL,
	"number_format" text DEFAULT 'en-SG' NOT NULL,
	"date_format" text DEFAULT 'dd MMM yyyy' NOT NULL,
	"timezone" text DEFAULT 'Asia/Singapore' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_single_row" CHECK ("settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "transaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"type" "transaction_type" NOT NULL,
	"quantity" numeric(38, 12) NOT NULL,
	"price" numeric(38, 12) NOT NULL,
	"commission_raw" text,
	"commission_value" numeric(38, 12),
	"commission_is_percent" boolean DEFAULT false NOT NULL,
	"executed_at" timestamp with time zone NOT NULL,
	"original_offset" text DEFAULT '+0800' NOT NULL,
	"currency" text NOT NULL,
	"purchase_fx_rate" numeric(38, 12),
	"purchase_fx_currencies" text,
	"accounting_method" text,
	"accounting_execution_ids" text,
	"notes" text,
	"outgoing_cash_link" text,
	"source_row_id" integer,
	"import_id" uuid,
	"dedupe_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "corporate_action" ADD CONSTRAINT "corporate_action_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio" ADD CONSTRAINT "portfolio_created_by_import_id_csv_import_log_id_fk" FOREIGN KEY ("created_by_import_id") REFERENCES "public"."csv_import_log"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_instrument" ADD CONSTRAINT "portfolio_instrument_portfolio_id_portfolio_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolio"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_instrument" ADD CONSTRAINT "portfolio_instrument_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_instrument" ADD CONSTRAINT "portfolio_instrument_created_by_import_id_csv_import_log_id_fk" FOREIGN KEY ("created_by_import_id") REFERENCES "public"."csv_import_log"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_bar" ADD CONSTRAINT "price_bar_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_portfolio_id_portfolio_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolio"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_import_id_csv_import_log_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."csv_import_log"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "corporate_action_instrument_idx" ON "corporate_action" USING btree ("instrument_id","ex_date");--> statement-breakpoint
CREATE UNIQUE INDEX "instrument_symbol_unique" ON "instrument" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "login_attempt_key_time_idx" ON "login_attempt" USING btree ("key","attempted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "portfolio_name_unique" ON "portfolio" USING btree ("name");--> statement-breakpoint
CREATE INDEX "transaction_portfolio_instrument_time_idx" ON "transaction" USING btree ("portfolio_id","instrument_id","executed_at");--> statement-breakpoint
CREATE INDEX "transaction_dedupe_idx" ON "transaction" USING btree ("dedupe_hash");--> statement-breakpoint
CREATE INDEX "transaction_import_idx" ON "transaction" USING btree ("import_id");