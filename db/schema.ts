/**
 * Folio database schema (Drizzle ORM, Turso / libSQL / SQLite).
 *
 * Design rules:
 *  - Single user: there is no user table and no user_id column. Access is
 *    controlled by the password gate, and the database is only ever reached
 *    from server code.
 *  - The transaction ledger is the source of truth. Positions, P&L and
 *    performance are always DERIVED from it and never stored.
 *  - Money, prices, share quantities, and FX rates use SQLite `TEXT` (exact
 *    decimal strings), NEVER IEEE-754 floats. Drizzle returns them as exact
 *    strings, which we feed directly into Decimal.js.
 *  - Timestamps use SQLite `INTEGER` (`mode: "timestamp_ms"`), storing Unix
 *    epoch milliseconds and hydrating to native JS `Date` objects with full
 *    millisecond precision.
 *  - Calendar dates (`YYYY-MM-DD`) use SQLite `TEXT`.
 *  - Booleans use SQLite `INTEGER` (`mode: "boolean"`) so Drizzle hydrates
 *    native JS `boolean` values (`true` / `false`).
 *  - JSON objects/arrays use SQLite `TEXT` (`mode: "json"`) so Drizzle
 *    automatically serializes and parses them.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// Shared column helpers
// ---------------------------------------------------------------------------

/**
 * Exact decimal stored as lossless UTF-8 text (never SQLite REAL/NUMERIC
 * float affinity). Covers values such as 4649.8599439776 and 326160 cleanly.
 */
function decimalColumn(name: string) {
  return text(name);
}

/**
 * UUIDv4 text primary key generated in application code.
 */
function uuidPrimaryKey() {
  return text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
}

/**
 * A function (not a shared constant) because Drizzle column builders must not
 * be reused between tables. Stores Unix epoch milliseconds (`INTEGER`) and
 * returns a native JS `Date`.
 */
function defaultNowTimestampColumn(name: string) {
  return integer(name, { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(CAST(unixepoch('subsec') * 1000 AS INTEGER))`)
    .$defaultFn(() => new Date());
}

function createdAtColumn() {
  return defaultNowTimestampColumn("created_at");
}

// ---------------------------------------------------------------------------
// Enum value tuples (enforced in TypeScript + SQLite CHECK constraints)
// ---------------------------------------------------------------------------

export const PORTFOLIO_TYPES = ["holdings", "watchlist"] as const;
export const ASSET_TYPES = [
  "stock",
  "etf",
  "reit",
  "index",
  "crypto",
  "unknown",
] as const;
export const TRANSACTION_TYPES = [
  "Buy",
  "Sell",
  "Sell All",
  "Dividend",
] as const;
export const DIVIDEND_MODES = ["cash", "shares"] as const;
export const IMPORT_STATUSES = ["committed", "undone"] as const;

// ---------------------------------------------------------------------------
// Settings (exactly one row)
// ---------------------------------------------------------------------------

export const settings = sqliteTable(
  "settings",
  {
    // The check constraint below forces this to always be 1, so the table
    // can only ever contain a single row.
    id: integer("id").primaryKey().default(1),
    baseCurrency: text("base_currency").notNull().default("SGD"),
    // Annual risk-free rate as a decimal fraction, e.g. "0.035" = 3.5%.
    riskFreeRate: text("risk_free_rate").notNull().default("0.035"),
    defaultBenchmark: text("default_benchmark").notNull().default("VOO"),
    // "all" or a holdings portfolio UUID displayed by default across views.
    defaultPortfolioId: text("default_portfolio_id").notNull().default("all"),
    costBasisMethod: text("cost_basis_method").notNull().default("FIFO"),
    // How to read the "Shares Owned" field on Dividend rows (see CSV spec 7.4).
    dividendMode: text("dividend_mode", { enum: DIVIDEND_MODES })
      .notNull()
      .default("cash"),
    // "system" | "light" | "dark"
    theme: text("theme").notNull().default("system"),
    // "green-up" | "red-up" | "color-blind-safe"
    gainColorScheme: text("gain_color_scheme").notNull().default("green-up"),
    numberFormat: text("number_format").notNull().default("en-SG"),
    dateFormat: text("date_format").notNull().default("dd MMM yyyy"),
    timezone: text("timezone").notNull().default("Asia/Singapore"),
    updatedAt: defaultNowTimestampColumn("updated_at"),
  },
  (table) => [
    check("settings_single_row", sql`${table.id} = 1`),
    check(
      "settings_dividend_mode_check",
      sql`${table.dividendMode} IN ('cash', 'shares')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// CSV import log (declared early because other tables reference it)
// ---------------------------------------------------------------------------

export const csvImportLog = sqliteTable(
  "csv_import_log",
  {
    id: uuidPrimaryKey(),
    filename: text("filename").notNull(),
    status: text("status", { enum: IMPORT_STATUSES })
      .notNull()
      .default("committed"),
    // e.g. { rowsRead: 273, transactions: 220, placeholders: 53, skipped: 0 }
    rowCounts: text("row_counts", { mode: "json" }).notNull().default({}),
    warnings: text("warnings", { mode: "json" }).notNull().default([]),
    createdAt: createdAtColumn(),
    undoneAt: integer("undone_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    check(
      "csv_import_log_status_check",
      sql`${table.status} IN ('committed', 'undone')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Portfolios
// ---------------------------------------------------------------------------

export const portfolio = sqliteTable(
  "portfolio",
  {
    id: uuidPrimaryKey(),
    // Portfolios are independent: the same symbol may appear in several.
    name: text("name").notNull(),
    type: text("type", { enum: PORTFOLIO_TYPES })
      .notNull()
      .default("holdings"),
    defaultCurrency: text("default_currency").notNull().default("USD"),
    sortOrder: integer("sort_order").notNull().default(0),
    // Set when an import created this portfolio, so "Undo import" can remove it.
    createdByImportId: text("created_by_import_id").references(
      () => csvImportLog.id,
      { onDelete: "set null" },
    ),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("portfolio_name_unique").on(table.name),
    check(
      "portfolio_type_check",
      sql`${table.type} IN ('holdings', 'watchlist')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

export const instrument = sqliteTable(
  "instrument",
  {
    id: uuidPrimaryKey(),
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
    assetType: text("asset_type", { enum: ASSET_TYPES })
      .notNull()
      .default("unknown"),
    // User-entered price for assets with no provider price (dead crypto, etc.).
    manualPrice: decimalColumn("manual_price"),
    // Marks collapsed or worthless assets so they never break totals.
    isDelisted: integer("is_delisted", { mode: "boolean" })
      .notNull()
      .default(false),
    // Set when providers return `not_found` so unlisted symbols aren't retried endlessly.
    priceNotFoundAt: integer("price_not_found_at", { mode: "timestamp_ms" }),
    priceNotFoundReason: text("price_not_found_reason"),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("instrument_symbol_unique").on(table.symbol),
    check(
      "instrument_asset_type_check",
      sql`${table.assetType} IN ('stock', 'etf', 'reit', 'index', 'crypto', 'unknown')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// PortfolioInstrument: "this symbol is tracked in this portfolio"
// Also stores watchlist data (date added, alerts, paper position).
// ---------------------------------------------------------------------------

export const portfolioInstrument = sqliteTable(
  "portfolio_instrument",
  {
    portfolioId: text("portfolio_id")
      .notNull()
      .references(() => portfolio.id, { onDelete: "cascade" }),
    instrumentId: text("instrument_id")
      .notNull()
      .references(() => instrument.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),

    // Watchlist fields
    dateAdded: defaultNowTimestampColumn("date_added"),
    priceWhenAdded: decimalColumn("price_when_added"),
    alertAbove: decimalColumn("alert_above"),
    alertBelow: decimalColumn("alert_below"),

    // Paper position ("if I had bought it")
    paperEntryDate: text("paper_entry_date"),
    paperAmount: decimalColumn("paper_amount"),
    paperShares: decimalColumn("paper_shares"),

    createdByImportId: text("created_by_import_id").references(
      () => csvImportLog.id,
      { onDelete: "set null" },
    ),
    createdAt: createdAtColumn(),
  },
  (table) => [primaryKey({ columns: [table.portfolioId, table.instrumentId] })],
);

// ---------------------------------------------------------------------------
// Transactions (the ledger)
// ---------------------------------------------------------------------------

export const transaction = sqliteTable(
  "transaction",
  {
    id: uuidPrimaryKey(),
    portfolioId: text("portfolio_id")
      .notNull()
      .references(() => portfolio.id, { onDelete: "cascade" }),
    instrumentId: text("instrument_id")
      .notNull()
      .references(() => instrument.id, { onDelete: "restrict" }),
    type: text("type", { enum: TRANSACTION_TYPES }).notNull(),

    // Buy/Sell: shares. Sell All: 0. Dividend: see settings.dividend_mode.
    quantity: decimalColumn("quantity").notNull(),
    // Trade price per share (the sale price on sells). May legitimately be 0.
    price: decimalColumn("price").notNull(),

    // Commission is stored three ways so the export can reproduce the original
    // text ("1%" or "1.14") while calculations use the parsed value.
    commissionRaw: text("commission_raw"),
    commissionValue: decimalColumn("commission_value"),
    commissionIsPercent: integer("commission_is_percent", { mode: "boolean" })
      .notNull()
      .default(false),

    // The exact instant, stored as UTC epoch ms. The original offset (e.g.
    // "+0800") is kept separately so exports can split date and time back out unchanged.
    executedAt: integer("executed_at", { mode: "timestamp_ms" }).notNull(),
    originalOffset: text("original_offset").notNull().default("+0800"),

    currency: text("currency").notNull(),
    purchaseFxRate: decimalColumn("purchase_fx_rate"),
    purchaseFxCurrencies: text("purchase_fx_currencies"),

    // Trade-entry market & FX snapshot fields (permanent record at entry time)
    priceAsOf: integer("price_as_of", { mode: "timestamp_ms" }),
    priceStatus: text("price_status"),
    fxRateToSgd: decimalColumn("fx_rate_to_sgd"),
    fxAsOf: integer("fx_as_of", { mode: "timestamp_ms" }),
    fxSource: text("fx_source"),
    totalCostSgd: decimalColumn("total_cost_sgd"),
    isManualPrice: integer("is_manual_price", { mode: "boolean" })
      .notNull()
      .default(false),
    isManualFxRate: integer("is_manual_fx_rate", { mode: "boolean" })
      .notNull()
      .default(false),

    accountingMethod: text("accounting_method"),
    accountingExecutionIds: text("accounting_execution_ids"),
    notes: text("notes"),
    outgoingCashLink: text("outgoing_cash_link"),

    // The Id column from the imported CSV, kept for audit and tie-breaking.
    sourceRowId: integer("source_row_id"),
    importId: text("import_id").references(() => csvImportLog.id, {
      onDelete: "set null",
    }),
    // Hash of (portfolio, symbol, type, quantity, price, executed_at) used to
    // detect duplicates on re-import. Deliberately NOT unique: "append" mode
    // may legitimately create look-alike rows.
    dedupeHash: text("dedupe_hash").notNull(),

    createdAt: createdAtColumn(),
    updatedAt: defaultNowTimestampColumn("updated_at"),
  },
  (table) => [
    index("transaction_portfolio_instrument_time_idx").on(
      table.portfolioId,
      table.instrumentId,
      table.executedAt,
    ),
    index("transaction_dedupe_idx").on(table.dedupeHash),
    index("transaction_import_idx").on(table.importId),
    check(
      "transaction_type_check",
      sql`${table.type} IN ('Buy', 'Sell', 'Sell All', 'Dividend')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Market-data caches stored in the database
// ---------------------------------------------------------------------------

/**
 * Daily bars. Closes are stored UNADJUSTED so valuations use the real price on
 * the date held. Splits are applied from the corporate_action table instead.
 */
export const priceBar = sqliteTable(
  "price_bar",
  {
    instrumentId: text("instrument_id")
      .notNull()
      .references(() => instrument.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    open: decimalColumn("open"),
    high: decimalColumn("high"),
    low: decimalColumn("low"),
    // Unadjusted close used for holdings valuation (corporate actions handled via split lots).
    close: decimalColumn("close").notNull(),
    // Dividend- & split-adjusted close used for total-return benchmark series.
    adjClose: decimalColumn("adj_close"),
    volume: decimalColumn("volume"),
    // Which provider supplied the bar, for transparency and debugging.
    source: text("source").notNull().default("unknown"),
  },
  (table) => [primaryKey({ columns: [table.instrumentId, table.date] })],
);

export const fxRate = sqliteTable(
  "fx_rate",
  {
    date: text("date").notNull(),
    fromCurrency: text("from_currency").notNull(),
    toCurrency: text("to_currency").notNull(),
    rate: decimalColumn("rate").notNull(),
    source: text("source").notNull().default("frankfurter"),
  },
  (table) => [
    primaryKey({
      columns: [table.date, table.fromCurrency, table.toCurrency],
    }),
  ],
);

/** Manually entered stock splits (see the "Corporate actions" screen). */
export const corporateAction = sqliteTable(
  "corporate_action",
  {
    id: uuidPrimaryKey(),
    instrumentId: text("instrument_id")
      .notNull()
      .references(() => instrument.id, { onDelete: "cascade" }),
    exDate: text("ex_date").notNull(),
    type: text("type").notNull().default("split"),
    // A 2-for-1 split is numerator=2, denominator=1.
    ratioNumerator: integer("ratio_numerator").notNull(),
    ratioDenominator: integer("ratio_denominator").notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    index("corporate_action_instrument_idx").on(
      table.instrumentId,
      table.exDate,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Login attempts (rate limiting for the password gate)
// ---------------------------------------------------------------------------

/**
 * Stored in the database, not memory, because serverless instances on Vercel
 * do not share memory between requests.
 */
export const loginAttempt = sqliteTable(
  "login_attempt",
  {
    id: uuidPrimaryKey(),
    // Client IP, or the literal "global" for the shared limit.
    key: text("key").notNull(),
    succeeded: integer("succeeded", { mode: "boolean" }).notNull(),
    attemptedAt: defaultNowTimestampColumn("attempted_at"),
  },
  (table) => [
    index("login_attempt_key_time_idx").on(table.key, table.attemptedAt),
  ],
);

export type Settings = typeof settings.$inferSelect;
export type Portfolio = typeof portfolio.$inferSelect;
export type Instrument = typeof instrument.$inferSelect;
export type PortfolioInstrument = typeof portfolioInstrument.$inferSelect;
export type Transaction = typeof transaction.$inferSelect;
export type NewTransaction = typeof transaction.$inferInsert;
