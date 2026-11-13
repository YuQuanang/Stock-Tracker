/**
 * Server-Side Watchlist Service (`lib/services/watchlist.ts`).
 *
 * Manages watchlist items (`portfolio_instrument` rows attached to portfolios
 * where `type = 'watchlist'`), automatic `price_when_added` capture, reorder,
 * price-alert thresholds, and the "If I had bought it" historical paper
 * position + benchmark comparison simulator.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import { type Database, getDb } from "@/db/client";
import {
  fxRate,
  instrument,
  type Instrument,
  portfolio,
  type Portfolio,
  portfolioInstrument,
} from "@/db/schema";
import {
  isStrictlyPositive,
  safeDivide,
  toDecimal,
  toDecimalString,
  toOptionalDecimal,
} from "@/lib/finance";
import {
  type CombinedMarketOverview,
  type ExchangeRateSnapshot,
  fetchExchangeRateToSgd,
  fetchInstrumentFundamentals,
  fetchStockPrice,
  getCombinedMarketOverview,
  type ResolvedInstrumentQuote,
  resolveQuotesForSymbols,
  type StockPriceQuote,
} from "@/lib/market-data";
import {
  computeLedgerSummaries,
  getOrCreateSettings,
  LedgerUserError,
  type LedgerPositionSummary,
  listPortfolios,
} from "@/lib/services/ledger";
import { inferInstrumentMetadata } from "@/lib/symbols";
import {
  computePaperComparison,
  type PaperBenchmarkComparison,
  type PaperComparisonResult,
  type SerializedWatchlistItem,
} from "@/lib/watchlist/valuation";

export interface WatchlistPageSnapshot {
  portfolios: Portfolio[];
  positions: LedgerPositionSummary[];
  items: SerializedWatchlistItem[];
  initialQuotes: Record<string, ResolvedInstrumentQuote>;
  initialFxUsdToSgd: ExchangeRateSnapshot | null;
  initialMarket: CombinedMarketOverview;
  baseCurrency: "SGD" | "USD";
  defaultBenchmark: string;
}

export interface PaperSimulationPreview {
  symbol: string;
  currency: "USD" | "SGD";
  entryDate: string;
  amount: string;
  benchmarkSymbol: string;
  benchmarkName: string;
  comparison: PaperComparisonResult;
  assetEntryDateUsed: string;
  assetEntryFreshness: string;
  assetCurrentFreshness: string;
  benchmarkEntryDateUsed: string | null;
}

const BENCHMARK_LABELS: Record<string, string> = {
  "^GSPC": "S&P 500",
  "^STI": "STI",
  "^IXIC": "NASDAQ",
  "^NDX": "Nasdaq 100",
  "^DJI": "Dow Jones",
};

export function getBenchmarkDisplayName(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  return BENCHMARK_LABELS[upper] ?? upper;
}

function getSgtTodayIso(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function normalizeOptionalPositiveDecimal(
  raw: string | null | undefined,
  fieldLabel: string,
): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  const parsed = toOptionalDecimal(trimmed);
  if (!parsed || !isStrictlyPositive(parsed)) {
    throw new LedgerUserError(`${fieldLabel} must be greater than zero.`, 422);
  }
  return toDecimalString(parsed, 12);
}

function normalizeSymbol(rawSymbol: string): string {
  return rawSymbol.trim().toUpperCase();
}

function normalizeCurrency(
  symbol: string,
  currencyHint: string | null | undefined,
): "USD" | "SGD" {
  if (currencyHint === "SGD") {
    return "SGD";
  }
  if (currencyHint === "USD") {
    return "USD";
  }
  return inferInstrumentMetadata({ symbol }).currency === "SGD" ? "SGD" : "USD";
}

async function requireWatchlistPortfolio(
  database: Database,
  portfolioId: string,
): Promise<Portfolio> {
  const rows = await database
    .select()
    .from(portfolio)
    .where(eq(portfolio.id, portfolioId))
    .limit(1);

  const found = rows[0];
  if (!found) {
    throw new LedgerUserError("Watchlist portfolio not found.", 404);
  }
  if (found.type !== "watchlist") {
    throw new LedgerUserError(
      `Portfolio "${found.name}" is a holdings portfolio, not a watchlist.`,
      422,
    );
  }
  return found;
}

async function findOrCreateWatchlistInstrument(
  database: Database,
  input: {
    symbol: string;
    name?: string | null;
    exchangeCode?: string | null;
    currency?: string | null;
  },
): Promise<Instrument> {
  const canonical = normalizeSymbol(input.symbol);
  if (!canonical) {
    throw new LedgerUserError("Ticker symbol is required.", 422);
  }

  const all = await database.select().from(instrument);
  const existing =
    all.find((item) => item.symbol === canonical) ??
    all.find((item) => item.symbol.toUpperCase() === canonical);

  if (existing) {
    const nextName = existing.name ?? (input.name?.trim() || null);
    const nextExchange =
      existing.exchangeCode ?? (input.exchangeCode?.trim() || null);
    if (
      nextName !== existing.name ||
      nextExchange !== existing.exchangeCode
    ) {
      const [updated] = await database
        .update(instrument)
        .set({
          name: nextName,
          exchangeCode: nextExchange,
        })
        .where(eq(instrument.id, existing.id))
        .returning();
      if (updated) {
        return updated;
      }
    }
    return existing;
  }

  const meta = inferInstrumentMetadata({ symbol: canonical });
  const resolvedCurrency = normalizeCurrency(canonical, input.currency);
  const [created] = await database
    .insert(instrument)
    .values({
      symbol: canonical,
      name: input.name?.trim() || null,
      exchangeCode: input.exchangeCode?.trim() || meta.exchangeCode,
      currency: resolvedCurrency,
      assetType: meta.assetType,
    })
    .returning();

  return created;
}

async function computeBenchmarkComparisonCached(input: {
  amount: string;
  entryDate: string;
  benchmarkSymbol: string;
  now: Date;
  fetchImpl?: typeof fetch;
  entryCache: Map<string, Promise<StockPriceQuote | null>>;
  currentCache: Map<string, Promise<StockPriceQuote | null>>;
}): Promise<PaperBenchmarkComparison | null> {
  const entryKey = `${input.benchmarkSymbol}::${input.entryDate}`;
  let entryPromise = input.entryCache.get(entryKey);
  if (!entryPromise) {
    entryPromise = fetchStockPrice(input.benchmarkSymbol, {
      date: input.entryDate,
      now: input.now,
      fetchImpl: input.fetchImpl,
    }).catch(() => null);
    input.entryCache.set(entryKey, entryPromise);
  }

  let currentPromise = input.currentCache.get(input.benchmarkSymbol);
  if (!currentPromise) {
    currentPromise = fetchStockPrice(input.benchmarkSymbol, {
      now: input.now,
      fetchImpl: input.fetchImpl,
    }).catch(() => null);
    input.currentCache.set(input.benchmarkSymbol, currentPromise);
  }

  const [entryQuote, currentQuote] = await Promise.all([
    entryPromise,
    currentPromise,
  ]);
  if (!entryQuote || !currentQuote) {
    return null;
  }

  const amountDec = toOptionalDecimal(input.amount);
  const entryDec = toOptionalDecimal(entryQuote.price);
  const currentDec = toOptionalDecimal(currentQuote.price);
  if (
    !amountDec ||
    !entryDec ||
    !currentDec ||
    !isStrictlyPositive(amountDec) ||
    !isStrictlyPositive(entryDec)
  ) {
    return null;
  }

  const benchmarkShares = safeDivide(amountDec, entryDec);
  if (!benchmarkShares) {
    return null;
  }

  const benchmarkValue = benchmarkShares.mul(currentDec);
  const benchmarkGain = benchmarkValue.minus(amountDec);
  const benchmarkGainPercent = benchmarkGain.div(amountDec).mul(100);

  return {
    benchmarkSymbol: input.benchmarkSymbol,
    benchmarkName: getBenchmarkDisplayName(input.benchmarkSymbol),
    entryDate: input.entryDate,
    entryPrice: toDecimalString(entryDec, 6),
    currentPrice: toDecimalString(currentDec, 6),
    benchmarkShares: toDecimalString(benchmarkShares, 8),
    benchmarkValue: toDecimalString(benchmarkValue, 6),
    benchmarkGain: toDecimalString(benchmarkGain, 6),
    benchmarkGainPercent: toDecimalString(benchmarkGainPercent, 6),
  };
}

function serializeWatchlistRow(input: {
  pi: typeof portfolioInstrument.$inferSelect;
  instr: Instrument;
  portfolioName: string;
  fiftyTwoWeekLow: string | null;
  fiftyTwoWeekHigh: string | null;
  paperBenchmark: PaperBenchmarkComparison | null;
}): SerializedWatchlistItem {
  return {
    portfolioId: input.pi.portfolioId,
    portfolioName: input.portfolioName,
    instrumentId: input.instr.id,
    symbol: input.instr.symbol,
    name: input.instr.name,
    exchangeCode: input.instr.exchangeCode,
    currency: input.instr.currency === "SGD" ? "SGD" : "USD",
    assetType: input.instr.assetType,
    priceNotFound: Boolean(input.instr.priceNotFoundAt),
    priceNotFoundReason: input.instr.priceNotFoundReason ?? null,
    sortOrder: input.pi.sortOrder,
    dateAdded: input.pi.dateAdded ? input.pi.dateAdded.toISOString() : null,
    priceWhenAdded: input.pi.priceWhenAdded
      ? toDecimalString(toDecimal(input.pi.priceWhenAdded), 6)
      : null,
    alertAbove: input.pi.alertAbove
      ? toDecimalString(toDecimal(input.pi.alertAbove), 6)
      : null,
    alertBelow: input.pi.alertBelow
      ? toDecimalString(toDecimal(input.pi.alertBelow), 6)
      : null,
    paperEntryDate: input.pi.paperEntryDate ?? null,
    paperAmount: input.pi.paperAmount
      ? toDecimalString(toDecimal(input.pi.paperAmount), 6)
      : null,
    paperShares: input.pi.paperShares
      ? toDecimalString(toDecimal(input.pi.paperShares), 8)
      : null,
    fiftyTwoWeekLow: input.fiftyTwoWeekLow,
    fiftyTwoWeekHigh: input.fiftyTwoWeekHigh,
    paperBenchmark: input.paperBenchmark,
  };
}

async function hydrateSerializedWatchlistItem(
  database: Database,
  portfolioId: string,
  instrumentId: string,
  defaultBenchmark: string,
  now: Date,
  fetchImpl?: typeof fetch,
): Promise<SerializedWatchlistItem> {
  const rows = await database
    .select({
      pi: portfolioInstrument,
      instr: instrument,
      portfolioName: portfolio.name,
    })
    .from(portfolioInstrument)
    .innerJoin(portfolio, eq(portfolioInstrument.portfolioId, portfolio.id))
    .innerJoin(instrument, eq(portfolioInstrument.instrumentId, instrument.id))
    .where(
      and(
        eq(portfolioInstrument.portfolioId, portfolioId),
        eq(portfolioInstrument.instrumentId, instrumentId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw new LedgerUserError("Watchlist item not found.", 404);
  }

  const skipFundamentals =
    row.instr.assetType === "crypto" ||
    row.instr.isDelisted ||
    Boolean(row.instr.priceNotFoundAt);
  const [fundamentals, paperBenchmark] = await Promise.all([
    skipFundamentals
      ? Promise.resolve(null)
      : fetchInstrumentFundamentals(row.instr.symbol, { now, fetchImpl }).catch(
          () => null,
        ),
    row.pi.paperEntryDate && row.pi.paperAmount && row.pi.paperShares
      ? computeBenchmarkComparisonCached({
          amount: row.pi.paperAmount,
          entryDate: row.pi.paperEntryDate,
          benchmarkSymbol: defaultBenchmark,
          now,
          fetchImpl,
          entryCache: new Map(),
          currentCache: new Map(),
        })
      : Promise.resolve(null),
  ]);

  return serializeWatchlistRow({
    pi: row.pi,
    instr: row.instr,
    portfolioName: row.portfolioName,
    fiftyTwoWeekLow: fundamentals?.fiftyTwoWeekLow ?? null,
    fiftyTwoWeekHigh: fundamentals?.fiftyTwoWeekHigh ?? null,
    paperBenchmark,
  });
}

/** Server loader for `/watchlist`. */
export async function getWatchlistPageSnapshot(options?: {
  db?: Database;
  fetchImpl?: typeof fetch;
}): Promise<WatchlistPageSnapshot> {
  const database = options?.db ?? (await getDb());
  const now = new Date();
  const initialMarket = getCombinedMarketOverview(now);

  const [portfolios, appSettings, ledgerSummary, joinedRows, latestFxRow] =
    await Promise.all([
      listPortfolios(database),
      getOrCreateSettings(database),
      computeLedgerSummaries(undefined, database),
      database
        .select({
          pi: portfolioInstrument,
          instr: instrument,
          portfolioName: portfolio.name,
        })
        .from(portfolioInstrument)
        .innerJoin(portfolio, eq(portfolioInstrument.portfolioId, portfolio.id))
        .innerJoin(instrument, eq(portfolioInstrument.instrumentId, instrument.id))
        .where(eq(portfolio.type, "watchlist"))
        .orderBy(
          asc(portfolio.sortOrder),
          asc(portfolioInstrument.sortOrder),
          asc(portfolioInstrument.createdAt),
        ),
      database
        .select()
        .from(fxRate)
        .where(eq(fxRate.fromCurrency, "USD"))
        .orderBy(desc(fxRate.date))
        .limit(1),
    ]);

  const baseCurrency = appSettings.baseCurrency === "USD" ? "USD" : "SGD";
  const defaultBenchmark = appSettings.defaultBenchmark || "^GSPC";

  const uniqueNonCryptoSymbols = [
    ...new Set(
      joinedRows
        .filter(
          (row) =>
            row.instr.assetType !== "crypto" &&
            !row.instr.isDelisted &&
            !row.instr.priceNotFoundAt,
        )
        .map((row) => row.instr.symbol),
    ),
  ];
  const allUniqueSymbols = [
    ...new Set(joinedRows.map((row) => row.instr.symbol)),
  ];

  const cachedFxFallback: ExchangeRateSnapshot | null = latestFxRow[0]
    ? {
        from: "USD",
        to: "SGD",
        rate: toDecimalString(toDecimal(latestFxRow[0].rate), 6),
        effectiveDate: latestFxRow[0].date,
        asOf: now.toISOString(),
        source: "frankfurter",
        label: "Cached FX rate",
        isHistorical: false,
      }
    : null;

  const entryCache = new Map<string, Promise<StockPriceQuote | null>>();
  const currentCache = new Map<string, Promise<StockPriceQuote | null>>();

  const [initialQuotes, initialFxUsdToSgd, fundamentalsEntries, benchmarkResults] =
    await Promise.all([
      resolveQuotesForSymbols({
        symbols: allUniqueSymbols,
        db: database,
        now,
        includeSparklines: true,
        fetchImpl: options?.fetchImpl,
      }),
      fetchExchangeRateToSgd({
        from: "USD",
        now,
        fetchImpl: options?.fetchImpl,
      }).catch(() => cachedFxFallback),
      Promise.all(
        uniqueNonCryptoSymbols.map(async (symbol) => {
          const data = await fetchInstrumentFundamentals(symbol, {
            now,
            fetchImpl: options?.fetchImpl,
          }).catch(() => null);
          return [symbol, data] as const;
        }),
      ),
      Promise.all(
        joinedRows.map(async (row) => {
          if (
            !row.pi.paperEntryDate ||
            !row.pi.paperAmount ||
            !row.pi.paperShares
          ) {
            return null;
          }
          return computeBenchmarkComparisonCached({
            amount: row.pi.paperAmount,
            entryDate: row.pi.paperEntryDate,
            benchmarkSymbol: defaultBenchmark,
            now,
            fetchImpl: options?.fetchImpl,
            entryCache,
            currentCache,
          });
        }),
      ),
    ]);

  const fundamentalsBySymbol = new Map(fundamentalsEntries);

  const items: SerializedWatchlistItem[] = joinedRows.map((row, index) => {
    const fundamentals = fundamentalsBySymbol.get(row.instr.symbol) ?? null;
    return serializeWatchlistRow({
      pi: row.pi,
      instr: row.instr,
      portfolioName: row.portfolioName,
      fiftyTwoWeekLow: fundamentals?.fiftyTwoWeekLow ?? null,
      fiftyTwoWeekHigh: fundamentals?.fiftyTwoWeekHigh ?? null,
      paperBenchmark: benchmarkResults[index] ?? null,
    });
  });

  return {
    portfolios,
    positions: ledgerSummary.positions,
    items,
    initialQuotes,
    initialFxUsdToSgd,
    initialMarket,
    baseCurrency,
    defaultBenchmark,
  };
}

/**
 * Adds a symbol to a watchlist portfolio, recording `priceWhenAdded` from live
 * or last-close quotes when available (without blocking or fabricating a price
 * if quotes are unavailable).
 */
export async function addWatchlistItem(
  input: {
    portfolioId: string;
    symbol: string;
    name?: string | null;
    exchangeCode?: string | null;
    currency?: string | null;
    priceWhenAdded?: string | null;
    alertAbove?: string | null;
    alertBelow?: string | null;
  },
  options?: { db?: Database; fetchImpl?: typeof fetch },
): Promise<SerializedWatchlistItem> {
  const database = options?.db ?? (await getDb());
  const now = new Date();
  await requireWatchlistPortfolio(database, input.portfolioId);

  const targetInstrument = await findOrCreateWatchlistInstrument(database, {
    symbol: input.symbol,
    name: input.name,
    exchangeCode: input.exchangeCode,
    currency: input.currency,
  });

  const existing = await database
    .select()
    .from(portfolioInstrument)
    .where(
      and(
        eq(portfolioInstrument.portfolioId, input.portfolioId),
        eq(portfolioInstrument.instrumentId, targetInstrument.id),
      ),
    )
    .limit(1);

  if (existing[0]) {
    throw new LedgerUserError(
      `${targetInstrument.symbol} is already in this watchlist.`,
      409,
    );
  }

  const alertAbove = normalizeOptionalPositiveDecimal(
    input.alertAbove,
    "Alert above target",
  );
  const alertBelow = normalizeOptionalPositiveDecimal(
    input.alertBelow,
    "Alert below target",
  );

  let priceWhenAdded = normalizeOptionalPositiveDecimal(
    input.priceWhenAdded,
    "Price when added",
  );

  if (priceWhenAdded === null && targetInstrument.assetType !== "crypto") {
    const liveQuote = await fetchStockPrice(targetInstrument.symbol, {
      now,
      fetchImpl: options?.fetchImpl,
    }).catch(() => null);
    if (liveQuote) {
      const parsedQuote = toOptionalDecimal(liveQuote.price);
      if (parsedQuote && isStrictlyPositive(parsedQuote)) {
        priceWhenAdded = toDecimalString(parsedQuote, 12);
      }
    }
  }

  const existingOrderRows = await database
    .select({ sortOrder: portfolioInstrument.sortOrder })
    .from(portfolioInstrument)
    .where(eq(portfolioInstrument.portfolioId, input.portfolioId));

  const maxSortOrder = existingOrderRows.reduce(
    (max, row) => (row.sortOrder > max ? row.sortOrder : max),
    -1,
  );

  await database.insert(portfolioInstrument).values({
    portfolioId: input.portfolioId,
    instrumentId: targetInstrument.id,
    sortOrder: maxSortOrder + 1,
    dateAdded: now,
    priceWhenAdded,
    alertAbove,
    alertBelow,
  });

  const appSettings = await getOrCreateSettings(database);
  return hydrateSerializedWatchlistItem(
    database,
    input.portfolioId,
    targetInstrument.id,
    appSettings.defaultBenchmark || "^GSPC",
    now,
    options?.fetchImpl,
  );
}

/**
 * Updates alert thresholds, reference `priceWhenAdded`, or the "If I had
 * bought it" paper position on an existing watchlist item.
 */
export async function updateWatchlistItem(
  input: {
    portfolioId: string;
    instrumentId: string;
    priceWhenAdded?: string | null;
    alertAbove?: string | null;
    alertBelow?: string | null;
    paperEntryDate?: string | null;
    paperAmount?: string | null;
    paperShares?: string | null;
    clearPaperPosition?: boolean;
  },
  options?: { db?: Database; fetchImpl?: typeof fetch },
): Promise<SerializedWatchlistItem> {
  const database = options?.db ?? (await getDb());
  const now = new Date();
  await requireWatchlistPortfolio(database, input.portfolioId);

  const existingRows = await database
    .select({
      pi: portfolioInstrument,
      instr: instrument,
    })
    .from(portfolioInstrument)
    .innerJoin(instrument, eq(portfolioInstrument.instrumentId, instrument.id))
    .where(
      and(
        eq(portfolioInstrument.portfolioId, input.portfolioId),
        eq(portfolioInstrument.instrumentId, input.instrumentId),
      ),
    )
    .limit(1);

  const existing = existingRows[0];
  if (!existing) {
    throw new LedgerUserError("Watchlist item not found.", 404);
  }

  const nextPriceWhenAdded =
    input.priceWhenAdded !== undefined
      ? normalizeOptionalPositiveDecimal(
          input.priceWhenAdded,
          "Price when added",
        )
      : existing.pi.priceWhenAdded;

  const nextAlertAbove =
    input.alertAbove !== undefined
      ? normalizeOptionalPositiveDecimal(input.alertAbove, "Alert above target")
      : existing.pi.alertAbove;

  const nextAlertBelow =
    input.alertBelow !== undefined
      ? normalizeOptionalPositiveDecimal(input.alertBelow, "Alert below target")
      : existing.pi.alertBelow;

  let nextPaperEntryDate = existing.pi.paperEntryDate;
  let nextPaperAmount = existing.pi.paperAmount;
  let nextPaperShares = existing.pi.paperShares;

  if (input.clearPaperPosition) {
    nextPaperEntryDate = null;
    nextPaperAmount = null;
    nextPaperShares = null;
  } else if (
    input.paperEntryDate !== undefined ||
    input.paperAmount !== undefined ||
    input.paperShares !== undefined
  ) {
    const rawDate =
      input.paperEntryDate !== undefined
        ? input.paperEntryDate?.trim() || null
        : existing.pi.paperEntryDate;
    const rawAmount =
      input.paperAmount !== undefined
        ? normalizeOptionalPositiveDecimal(
            input.paperAmount,
            "Simulated investment amount",
          )
        : existing.pi.paperAmount;

    if (!rawDate && !rawAmount) {
      nextPaperEntryDate = null;
      nextPaperAmount = null;
      nextPaperShares = null;
    } else {
      if (!rawDate || !/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
        throw new LedgerUserError(
          "Please enter a valid simulation entry date (YYYY-MM-DD).",
          422,
        );
      }
      if (rawDate > getSgtTodayIso(now)) {
        throw new LedgerUserError(
          "Simulation entry date cannot be in the future.",
          422,
        );
      }
      if (!rawAmount) {
        throw new LedgerUserError(
          "Please enter a positive investment amount to simulate.",
          422,
        );
      }
      if (existing.instr.assetType === "crypto") {
        throw new LedgerUserError(
          "Price simulation is unavailable for crypto symbols.",
          422,
        );
      }

      const explicitShares =
        input.paperShares !== undefined
          ? normalizeOptionalPositiveDecimal(
              input.paperShares,
              "Simulated shares",
            )
          : null;

      if (explicitShares) {
        nextPaperShares = explicitShares;
      } else {
        let entryQuote: StockPriceQuote;
        try {
          entryQuote = await fetchStockPrice(existing.instr.symbol, {
            date: rawDate,
            now,
            fetchImpl: options?.fetchImpl,
          });
        } catch {
          throw new LedgerUserError(
            `Historical price unavailable for ${existing.instr.symbol} on ${rawDate}. Enter shares manually or choose another trading day.`,
            422,
          );
        }
        const entryPrice = toOptionalDecimal(entryQuote.price);
        if (!entryPrice || !isStrictlyPositive(entryPrice)) {
          throw new LedgerUserError(
            `Historical price unavailable for ${existing.instr.symbol} on ${rawDate}.`,
            422,
          );
        }
        const computedShares = safeDivide(toDecimal(rawAmount), entryPrice);
        if (!computedShares || !isStrictlyPositive(computedShares)) {
          throw new LedgerUserError(
            "Unable to compute simulated share count.",
            422,
          );
        }
        nextPaperShares = toDecimalString(computedShares, 12);
      }

      nextPaperEntryDate = rawDate;
      nextPaperAmount = rawAmount;
    }
  }

  await database
    .update(portfolioInstrument)
    .set({
      priceWhenAdded: nextPriceWhenAdded,
      alertAbove: nextAlertAbove,
      alertBelow: nextAlertBelow,
      paperEntryDate: nextPaperEntryDate,
      paperAmount: nextPaperAmount,
      paperShares: nextPaperShares,
    })
    .where(
      and(
        eq(portfolioInstrument.portfolioId, input.portfolioId),
        eq(portfolioInstrument.instrumentId, input.instrumentId),
      ),
    );

  const appSettings = await getOrCreateSettings(database);
  return hydrateSerializedWatchlistItem(
    database,
    input.portfolioId,
    input.instrumentId,
    appSettings.defaultBenchmark || "^GSPC",
    now,
    options?.fetchImpl,
  );
}

/** Removes an instrument from a watchlist without deleting underlying ledger history. */
export async function removeWatchlistItem(
  input: { portfolioId: string; instrumentId: string },
  options?: { db?: Database },
): Promise<void> {
  const database = options?.db ?? (await getDb());
  await requireWatchlistPortfolio(database, input.portfolioId);

  const deleted = await database
    .delete(portfolioInstrument)
    .where(
      and(
        eq(portfolioInstrument.portfolioId, input.portfolioId),
        eq(portfolioInstrument.instrumentId, input.instrumentId),
      ),
    )
    .returning();

  if (!deleted[0]) {
    throw new LedgerUserError("Watchlist item not found.", 404);
  }
}

/** Persists custom drag/arrow order for items inside a watchlist. */
export async function reorderWatchlistItems(
  input: { portfolioId: string; orderedInstrumentIds: string[] },
  options?: { db?: Database },
): Promise<void> {
  const database = options?.db ?? (await getDb());
  await requireWatchlistPortfolio(database, input.portfolioId);

  const existing = await database
    .select()
    .from(portfolioInstrument)
    .where(eq(portfolioInstrument.portfolioId, input.portfolioId))
    .orderBy(asc(portfolioInstrument.sortOrder), asc(portfolioInstrument.createdAt));

  const existingIds = new Set(existing.map((row) => row.instrumentId));
  const seen = new Set<string>();
  const finalOrder: string[] = [];

  for (const id of input.orderedInstrumentIds) {
    if (existingIds.has(id) && !seen.has(id)) {
      seen.add(id);
      finalOrder.push(id);
    }
  }
  for (const row of existing) {
    if (!seen.has(row.instrumentId)) {
      seen.add(row.instrumentId);
      finalOrder.push(row.instrumentId);
    }
  }

  await database.transaction(async (txDatabase) => {
    for (let index = 0; index < finalOrder.length; index++) {
      await txDatabase
        .update(portfolioInstrument)
        .set({ sortOrder: index })
        .where(
          and(
            eq(portfolioInstrument.portfolioId, input.portfolioId),
            eq(portfolioInstrument.instrumentId, finalOrder[index]),
          ),
        );
    }
  });
}

/**
 * Live preview for the "If I had bought it" paper simulator sheet, fetching
 * the target stock's historical entry close + latest price alongside the
 * user's benchmark index over the exact same period.
 */
export async function previewPaperSimulation(
  input: {
    symbol: string;
    entryDate: string;
    amount: string;
    benchmarkSymbol?: string;
  },
  options?: { db?: Database; fetchImpl?: typeof fetch },
): Promise<PaperSimulationPreview> {
  const now = new Date();
  const canonical = normalizeSymbol(input.symbol);
  if (!canonical) {
    throw new LedgerUserError("Ticker symbol is required.", 422);
  }

  const trimmedDate = input.entryDate.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmedDate)) {
    throw new LedgerUserError("Entry date must be formatted YYYY-MM-DD.", 422);
  }
  if (trimmedDate > getSgtTodayIso(now)) {
    throw new LedgerUserError("Entry date cannot be in the future.", 422);
  }

  const normalizedAmount = normalizeOptionalPositiveDecimal(
    input.amount,
    "Simulated investment amount",
  );
  if (!normalizedAmount) {
    throw new LedgerUserError("Investment amount is required.", 422);
  }

  const meta = inferInstrumentMetadata({ symbol: canonical });
  if (meta.assetType === "crypto") {
    throw new LedgerUserError(
      "Price simulation is unavailable for crypto symbols.",
      422,
    );
  }

  let benchmarkSymbol = input.benchmarkSymbol?.trim().toUpperCase();
  if (!benchmarkSymbol && options?.db) {
    const appSettings = await getOrCreateSettings(options.db);
    benchmarkSymbol = appSettings.defaultBenchmark || "^GSPC";
  } else if (!benchmarkSymbol) {
    const database = await getDb();
    const appSettings = await getOrCreateSettings(database);
    benchmarkSymbol = appSettings.defaultBenchmark || "^GSPC";
  }

  const [assetEntry, assetCurrent, benchmarkEntry, benchmarkCurrent] =
    await Promise.all([
      fetchStockPrice(canonical, {
        date: trimmedDate,
        now,
        fetchImpl: options?.fetchImpl,
      }),
      fetchStockPrice(canonical, {
        now,
        fetchImpl: options?.fetchImpl,
      }),
      fetchStockPrice(benchmarkSymbol, {
        date: trimmedDate,
        now,
        fetchImpl: options?.fetchImpl,
      }).catch(() => null),
      fetchStockPrice(benchmarkSymbol, {
        now,
        fetchImpl: options?.fetchImpl,
      }).catch(() => null),
    ]);

  const comparison = computePaperComparison({
    amount: normalizedAmount,
    assetEntryPrice: assetEntry.price,
    assetCurrentPrice: assetCurrent.price,
    benchmarkEntryPrice: benchmarkEntry?.price ?? null,
    benchmarkCurrentPrice: benchmarkCurrent?.price ?? null,
  });

  if (!comparison) {
    throw new LedgerUserError(
      `Unable to simulate ${canonical} on ${trimmedDate}.`,
      422,
    );
  }

  return {
    symbol: canonical,
    currency: assetCurrent.currency === "SGD" ? "SGD" : "USD",
    entryDate: trimmedDate,
    amount: normalizedAmount,
    benchmarkSymbol,
    benchmarkName: getBenchmarkDisplayName(benchmarkSymbol),
    comparison,
    assetEntryDateUsed: assetEntry.effectiveDate,
    assetEntryFreshness: assetEntry.freshnessLabel,
    assetCurrentFreshness: assetCurrent.freshnessLabel,
    benchmarkEntryDateUsed: benchmarkEntry?.effectiveDate ?? null,
  };
}
