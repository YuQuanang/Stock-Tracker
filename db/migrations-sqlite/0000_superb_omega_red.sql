CREATE TABLE `corporate_action` (
	`id` text PRIMARY KEY NOT NULL,
	`instrument_id` text NOT NULL,
	`ex_date` text NOT NULL,
	`type` text DEFAULT 'split' NOT NULL,
	`ratio_numerator` integer NOT NULL,
	`ratio_denominator` integer NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`instrument_id`) REFERENCES `instrument`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `corporate_action_instrument_idx` ON `corporate_action` (`instrument_id`,`ex_date`);--> statement-breakpoint
CREATE TABLE `csv_import_log` (
	`id` text PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`status` text DEFAULT 'committed' NOT NULL,
	`row_counts` text DEFAULT '{}' NOT NULL,
	`warnings` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`undone_at` integer,
	CONSTRAINT "csv_import_log_status_check" CHECK("csv_import_log"."status" IN ('committed', 'undone'))
);
--> statement-breakpoint
CREATE TABLE `fx_rate` (
	`date` text NOT NULL,
	`from_currency` text NOT NULL,
	`to_currency` text NOT NULL,
	`rate` text NOT NULL,
	`source` text DEFAULT 'frankfurter' NOT NULL,
	PRIMARY KEY(`date`, `from_currency`, `to_currency`)
);
--> statement-breakpoint
CREATE TABLE `instrument` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`name` text,
	`import_name` text,
	`import_display_symbol` text,
	`exchange_code` text,
	`currency` text DEFAULT 'USD' NOT NULL,
	`asset_type` text DEFAULT 'unknown' NOT NULL,
	`manual_price` text,
	`is_delisted` integer DEFAULT false NOT NULL,
	`price_not_found_at` integer,
	`price_not_found_reason` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	CONSTRAINT "instrument_asset_type_check" CHECK("instrument"."asset_type" IN ('stock', 'etf', 'reit', 'index', 'crypto', 'unknown'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `instrument_symbol_unique` ON `instrument` (`symbol`);--> statement-breakpoint
CREATE TABLE `login_attempt` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`succeeded` integer NOT NULL,
	`attempted_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `login_attempt_key_time_idx` ON `login_attempt` (`key`,`attempted_at`);--> statement-breakpoint
CREATE TABLE `portfolio` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'holdings' NOT NULL,
	`default_currency` text DEFAULT 'USD' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_by_import_id` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`created_by_import_id`) REFERENCES `csv_import_log`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "portfolio_type_check" CHECK("portfolio"."type" IN ('holdings', 'watchlist'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `portfolio_name_unique` ON `portfolio` (`name`);--> statement-breakpoint
CREATE TABLE `portfolio_instrument` (
	`portfolio_id` text NOT NULL,
	`instrument_id` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`date_added` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`price_when_added` text,
	`alert_above` text,
	`alert_below` text,
	`paper_entry_date` text,
	`paper_amount` text,
	`paper_shares` text,
	`created_by_import_id` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	PRIMARY KEY(`portfolio_id`, `instrument_id`),
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolio`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`instrument_id`) REFERENCES `instrument`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_import_id`) REFERENCES `csv_import_log`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `price_bar` (
	`instrument_id` text NOT NULL,
	`date` text NOT NULL,
	`open` text,
	`high` text,
	`low` text,
	`close` text NOT NULL,
	`adj_close` text,
	`volume` text,
	`source` text DEFAULT 'unknown' NOT NULL,
	PRIMARY KEY(`instrument_id`, `date`),
	FOREIGN KEY (`instrument_id`) REFERENCES `instrument`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`base_currency` text DEFAULT 'SGD' NOT NULL,
	`risk_free_rate` text DEFAULT '0.035' NOT NULL,
	`default_benchmark` text DEFAULT 'VOO' NOT NULL,
	`default_portfolio_id` text DEFAULT 'all' NOT NULL,
	`cost_basis_method` text DEFAULT 'FIFO' NOT NULL,
	`dividend_mode` text DEFAULT 'cash' NOT NULL,
	`theme` text DEFAULT 'system' NOT NULL,
	`gain_color_scheme` text DEFAULT 'green-up' NOT NULL,
	`number_format` text DEFAULT 'en-SG' NOT NULL,
	`date_format` text DEFAULT 'dd MMM yyyy' NOT NULL,
	`timezone` text DEFAULT 'Asia/Singapore' NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	CONSTRAINT "settings_single_row" CHECK("settings"."id" = 1),
	CONSTRAINT "settings_dividend_mode_check" CHECK("settings"."dividend_mode" IN ('cash', 'shares'))
);
--> statement-breakpoint
CREATE TABLE `transaction` (
	`id` text PRIMARY KEY NOT NULL,
	`portfolio_id` text NOT NULL,
	`instrument_id` text NOT NULL,
	`type` text NOT NULL,
	`quantity` text NOT NULL,
	`price` text NOT NULL,
	`commission_raw` text,
	`commission_value` text,
	`commission_is_percent` integer DEFAULT false NOT NULL,
	`executed_at` integer NOT NULL,
	`original_offset` text DEFAULT '+0800' NOT NULL,
	`currency` text NOT NULL,
	`purchase_fx_rate` text,
	`purchase_fx_currencies` text,
	`price_as_of` integer,
	`price_status` text,
	`fx_rate_to_sgd` text,
	`fx_as_of` integer,
	`fx_source` text,
	`total_cost_sgd` text,
	`is_manual_price` integer DEFAULT false NOT NULL,
	`is_manual_fx_rate` integer DEFAULT false NOT NULL,
	`accounting_method` text,
	`accounting_execution_ids` text,
	`notes` text,
	`outgoing_cash_link` text,
	`source_row_id` integer,
	`import_id` text,
	`dedupe_hash` text NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolio`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`instrument_id`) REFERENCES `instrument`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`import_id`) REFERENCES `csv_import_log`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "transaction_type_check" CHECK("transaction"."type" IN ('Buy', 'Sell', 'Sell All', 'Dividend'))
);
--> statement-breakpoint
CREATE INDEX `transaction_portfolio_instrument_time_idx` ON `transaction` (`portfolio_id`,`instrument_id`,`executed_at`);--> statement-breakpoint
CREATE INDEX `transaction_dedupe_idx` ON `transaction` (`dedupe_hash`);--> statement-breakpoint
CREATE INDEX `transaction_import_idx` ON `transaction` (`import_id`);