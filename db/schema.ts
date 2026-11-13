/**
 * Folio database schema (Drizzle ORM, PostgreSQL).
 *
 * Design rules:
 *  - Single user: there is no user table and no user_id column. Access is
 *    controlled by the password gate, and the database is only ever reached
 *    from server code.
 *  - The transaction ledger is the source of truth. Positions, P&L and
 *    performance are always DERIVED from it and never stored.
 *  - Money and quantities use `numeric` (exact decimals), never floats.
 *    Drizzle returns numeric columns as strings, which we feed to Decimal.js.
 *  - Every instrument keeps its native currency. Conversion to the base
 *    currency happens only for display and aggregation.
 */
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Shared column helpers
// ---------------------------------------------------------------------------

/**
 * Exact decimal used for prices, quantities and amounts.
 * 38 digits with 12 after the decimal point comfortably covers values such as
 * 4649.8599439776 (price) and 326160 (crypto quantity) from the CSV.
 */
function decimalColumn(name: string) {
  return numeric(name, { precision: 38, scale: 12 });
}

/**
 * A function (not a shared constant) because Drizzle column builders must not
 * be reused between tables.
 */
function createdAtColumn() {
  return timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const portfolioTypeEnum = pgEnum("portfolio_type", ["holdings", "watchlist"]);

export const assetTypeEnum = pgEnum("asset_type", [
  "stock",
  "etf",
  "reit",
  "index",
  "crypto",
  "unknown",
]);

export const transactionTypeEnum = pgEnum("transaction_type", [
  "Buy",
  "Sell",
  "Sell All",
  "Dividend",
]);

export const dividendModeEnum = pgEnum("dividend_mode", ["cash", "shares"]);

export const importStatusEnum = pgEnum("import_status", ["committed", "undone"]);

// ---------------------------------------------------------------------------
// Settings (exactly one row)
// ---------------------------------------------------------------------------

export const settings = pgTable(
  "settings",
  {
    // The check constraint below forces this to always be 1, so the table
    // can only ever contain a single row.
    id: smallint("id").primaryKey().default(1),
    baseCurrency: text("base_currency").notNull().default("SGD"),
    // Annual risk-free rate as a decimal fraction, e.g. 0.035 = 3.5%.
    riskFreeRate: numeric("risk_free_rate", { precision: 8, scale: 6 })
      .notNull()
      .default("0.035"),
    defaultBenchmark: text("default_benchmark").notNull().default("^GSPC"),
    costBasisMethod: text("cost_basis_method").notNull().default("FIFO"),
    // How to read the "Shares Owned" field on Dividend rows (see CSV spec 7.4).
    dividendMode: dividendModeEnum("dividend_mode").notNull().default("cash"),
    // "system" | "light" | "dark"
    theme: text("theme").notNull().default("system"),
    // "green-up" | "red-up" | "color-blind-safe"
    gainColorScheme: text("gain_color_scheme").notNull().default("green-up"),
    numberFormat: text("number_format").notNull().default("en-SG"),
    dateFormat: text("date_format").notNull().default("dd MMM yyyy"),
    timezone: text("timezone").notNull().default("Asia/Singapore"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("settings_single_row", sql`${table.id} = 1`)],
);

// ---------------------------------------------------------------------------
// CSV import log (declared early because other tables reference it)
// ---------------------------------------------------------------------------

export const csvImportLog = pgTable("csv_import_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  filename: text("filename").notNull(),
  status: importStatusEnum("status").notNull().default("committed"),
  // e.g. { rowsRead: 273, transactions: 220, placeholders: 53, skipped: 0 }
  rowCounts: jsonb("row_counts").notNull().default({}),
  warnings: jsonb("warnings").notNull().default([]),
  createdAt: createdAtColumn(),
  undoneAt: timestamp("undone_at", { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// Portfolios
// ---------------------------------------------------------------------------

export const portfolio = pgTable(
  "portfolio",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Portfolios are independent: the same symbol may appear in several.
    name: text("name").notNull(),
    type: portfolioTypeEnum("type").notNull().default("holdings"),
    defaultCurrency: text("default_currency").notNull().default("USD"),
    sortOrder: integer("sort_order").notNull().default(0),
    // Set when an import created this portfolio, so "Undo import" can remove it.
    createdByImportId: uuid("created_by_import_id").references(() => csvImportLog.id, {
      onDelete: "set null",
    }),
    createdAt: createdAtColumn(),
  },
  (table) => [uniqueIndex("portfolio_name_unique").on(table.name)],
);

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

export const instrument = pgTable(
  "instrument",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Yahoo-style ticker, case preserved exactly as imported (AAPL, ES3.SI, ^GSPC).
    symbol: text("symbol").notNull(),
    // Name refreshed from the provider for display.
    name: text("name"),
    // Name exactly as it appeared in the CSV (may be empty or have trailing
    // spaces). Kept so the original-format export is lossless.
    importName: text("import_name"),
    importDisplaySymbol: text("import_display_symbol"),
    // Short exchange code from the CSV: NMS, NYQ, PCX, SES, DJI, ...
    exchangeCode: text("exchange_code"),
    currency: text("currency").notNull().default("USD"),
    assetType: assetTypeEnum("asset_type").notNull().default("unknown"),
    // User-entered price for assets with no provider price (dead crypto, etc.).
    manualPrice: decimalColumn("manual_price"),
    // Marks collapsed or worthless assets so they never break totals.
    isDelisted: boolean("is_delisted").notNull().default(false),
    // Set when providers return `not_found` so unlisted symbols aren't retried endlessly.
    priceNotFoundAt: timestamp("price_not_found_at", { withTimezone: true }),
    priceNotFoundReason: text("price_not_found_reason"),
    createdAt: createdAtColumn(),
  },
  (table) => [uniqueIndex("instrument_symbol_unique").on(table.symbol)],
);

// ---------------------------------------------------------------------------
// PortfolioInstrument: "this symbol is tracked in this portfolio"
// Also stores watchlist data (date added, alerts, paper position).
// ---------------------------------------------------------------------------

export const portfolioInstrument = pgTable(
  "portfolio_instrument",
  {
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolio.id, { onDelete: "cascade" }),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instrument.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),

    // Watchlist fields
    dateAdded: timestamp("date_added", { withTimezone: true }).notNull().defaultNow(),
    priceWhenAdded: decimalColumn("price_when_added"),
    alertAbove: decimalColumn("alert_above"),
    alertBelow: decimalColumn("alert_below"),

    // Paper position ("if I had bought it")
    paperEntryDate: date("paper_entry_date", { mode: "string" }),
    paperAmount: decimalColumn("paper_amount"),
    paperShares: decimalColumn("paper_shares"),

    createdByImportId: uuid("created_by_import_id").references(() => csvImportLog.id, {
      onDelete: "set null",
    }),
    createdAt: createdAtColumn(),
  },
  (table) => [primaryKey({ columns: [table.portfolioId, table.instrumentId] })],
);

// ---------------------------------------------------------------------------
// Transactions (the ledger)
// ---------------------------------------------------------------------------

export const transaction = pgTable(
  "transaction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolio.id, { onDelete: "cascade" }),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instrument.id, { onDelete: "restrict" }),
    type: transactionTypeEnum("type").notNull(),

    // Buy/Sell: shares. Sell All: 0. Dividend: see settings.dividend_mode.
    quantity: decimalColumn("quantity").notNull(),
    // Trade price per share (the sale price on sells). May legitimately be 0.
    price: decimalColumn("price").notNull(),

    // Commission is stored three ways so the export can reproduce the original
    // text ("1%" or "1.14") while calculations use the parsed value.
    commissionRaw: text("commission_raw"),
    commissionValue: decimalColumn("commission_value"),
    commissionIsPercent: boolean("commission_is_percent").notNull().default(false),

    // The exact instant, stored in UTC. The original offset (e.g. "+0800") is
    // kept separately so exports can split date and time back out unchanged.
    executedAt: timestamp("executed_at", { withTimezone: true }).notNull(),
    originalOffset: text("original_offset").notNull().default("+0800"),

    currency: text("currency").notNull(),
    purchaseFxRate: decimalColumn("purchase_fx_rate"),
    purchaseFxCurrencies: text("purchase_fx_currencies"),

    // Trade-entry market & FX snapshot fields (permanent record at entry time)
    priceAsOf: timestamp("price_as_of", { withTimezone: true }),
    priceStatus: text("price_status"),
    fxRateToSgd: decimalColumn("fx_rate_to_sgd"),
    fxAsOf: timestamp("fx_as_of", { withTimezone: true }),
    fxSource: text("fx_source"),
    totalCostSgd: decimalColumn("total_cost_sgd"),
    isManualPrice: boolean("is_manual_price").notNull().default(false),
    isManualFxRate: boolean("is_manual_fx_rate").notNull().default(false),

    accountingMethod: text("accounting_method"),
    accountingExecutionIds: text("accounting_execution_ids"),
    notes: text("notes"),
    outgoingCashLink: text("outgoing_cash_link"),

    // The Id column from the imported CSV, kept for audit and tie-breaking.
    sourceRowId: integer("source_row_id"),
    importId: uuid("import_id").references(() => csvImportLog.id, {
      onDelete: "set null",
    }),
    // Hash of (portfolio, symbol, type, quantity, price, executed_at) used to
    // detect duplicates on re-import. Deliberately NOT unique: "append" mode
    // may legitimately create look-alike rows.
    dedupeHash: text("dedupe_hash").notNull(),

    createdAt: createdAtColumn(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("transaction_portfolio_instrument_time_idx").on(
      table.portfolioId,
      table.instrumentId,
      table.executedAt,
    ),
    index("transaction_dedupe_idx").on(table.dedupeHash),
    index("transaction_import_idx").on(table.importId),
  ],
);

// ---------------------------------------------------------------------------
// Market-data caches stored in the database
// ---------------------------------------------------------------------------

/**
 * Daily bars. Closes are stored UNADJUSTED so valuations use the real price on
 * the date held. Splits are applied from the corporate_action table instead.
 */
export const priceBar = pgTable(
  "price_bar",
  {
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instrument.id, { onDelete: "cascade" }),
    date: date("date", { mode: "string" }).notNull(),
    open: decimalColumn("open"),
    high: decimalColumn("high"),
    low: decimalColumn("low"),
    close: decimalColumn("close").notNull(),
    volume: decimalColumn("volume"),
    // Which provider supplied the bar, for transparency and debugging.
    source: text("source").notNull().default("unknown"),
  },
  (table) => [primaryKey({ columns: [table.instrumentId, table.date] })],
);

export const fxRate = pgTable(
  "fx_rate",
  {
    date: date("date", { mode: "string" }).notNull(),
    fromCurrency: text("from_currency").notNull(),
    toCurrency: text("to_currency").notNull(),
    rate: numeric("rate", { precision: 20, scale: 10 }).notNull(),
    source: text("source").notNull().default("frankfurter"),
  },
  (table) => [primaryKey({ columns: [table.date, table.fromCurrency, table.toCurrency] })],
);

/** Manually entered stock splits (see the "Corporate actions" screen). */
export const corporateAction = pgTable(
  "corporate_action",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instrument.id, { onDelete: "cascade" }),
    exDate: date("ex_date", { mode: "string" }).notNull(),
    type: text("type").notNull().default("split"),
    // A 2-for-1 split is numerator=2, denominator=1.
    ratioNumerator: integer("ratio_numerator").notNull(),
    ratioDenominator: integer("ratio_denominator").notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [index("corporate_action_instrument_idx").on(table.instrumentId, table.exDate)],
);

// ---------------------------------------------------------------------------
// Login attempts (rate limiting for the password gate)
// ---------------------------------------------------------------------------

/**
 * Stored in the database, not memory, because serverless instances on Vercel
 * do not share memory between requests.
 */
export const loginAttempt = pgTable(
  "login_attempt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Client IP, or the literal "global" for the shared limit.
    key: text("key").notNull(),
    succeeded: boolean("succeeded").notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("login_attempt_key_time_idx").on(table.key, table.attemptedAt)],
);

export type Settings = typeof settings.$inferSelect;
export type Portfolio = typeof portfolio.$inferSelect;
export type Instrument = typeof instrument.$inferSelect;
export type PortfolioInstrument = typeof portfolioInstrument.$inferSelect;
export type Transaction = typeof transaction.$inferSelect;
export type NewTransaction = typeof transaction.$inferInsert;
