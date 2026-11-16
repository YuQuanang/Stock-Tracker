/**
 * Server-Side Portfolio Analytics & Benchmark Comparison Engine (`lib/services/analytics.ts`).
 *
 * Powers `/dashboard`, `/benchmarks`, and `/api/analytics`:
 *  1. Evaluates FIFO ledgers across all holdings portfolios (`applySymbolWideSellAll`
 *     preserved), scoped to `"all"` or a single portfolio, and denominated in
 *     the user's chosen comparison currency (`"SGD"` or `"USD"`).
 *  2. Ensures unadjusted daily `price_bar` history and historical `USD <-> SGD`
 *     FX rates (`fx_rate`) are synced with bounded concurrency (`limit = 6`)
 *     while skipping crypto external requests and never inventing data.
 *  3. Reconstructs daily portfolio valuation, TWR (`lib/finance/twr.ts`), XIRR
 *     (`lib/finance/xirr.ts`), underwater drawdown (`lib/finance/drawdown.ts`),
 *     volatility / Sharpe / Beta / Correlation / Alpha / Same-Cash-Flows
 *     (`lib/finance/risk-metrics.ts`), 5-way allocation breakdowns, top gainers &
 *     losers, dividend stats, and Data Quality disclosures.
 */
import { inArray } from "drizzle-orm";
import { type Database, getDb } from "@/db/client";
import {
  fxRate,
  instrument,
  type Portfolio,
  priceBar,
  type Settings,
} from "@/db/schema";
import {
  computeAnnualizedVolatility,
  computeBenchmarkRegression,
  computeBestWorstPeriods,
  computeCagr,
  computeCommissionAmount,
  computeDrawdownSeries,
  computeHorizonReturns,
  computeSameCashFlowsSimulation,
  computeSharpeRatio,
  computeTimeWeightedReturn,
  computeXirr,
  type DecimalValue,
  formatInstantInOffset,
  FxRateBook,
  HUNDRED,
  lookupFxRate,
  ONE,
  type PeriodReturnKey,
  reconstructPortfolioTimeline,
  safeDivide,
  type SameCashFlowsSimulationResult,
  toDecimal,
  toDecimalString,
  toNullableDecimalString,
  toOptionalDecimal,
  ZERO,
} from "@/lib/finance";
import {
  buildValuedHoldings,
  type HoldingsOverviewSummary,
  type ValuedHoldingRow,
} from "@/lib/holdings/valuation";
import {
  type CombinedMarketOverview,
  ensureInstrumentDailyBars,
  type ExchangeRateSnapshot,
  fetchExchangeRateToSgd,
  fetchInstrumentFundamentals,
  getCachedInstrumentFundamentals,
  getCachedUsdToSgdSnapshot,
  getCombinedMarketOverview,
  getSingaporeDateString,
  inferMarketRegion,
  type InstrumentFundamentals,
  type ResolvedInstrumentQuote,
  resolveQuotesForSymbols,
} from "@/lib/market-data";
import {
  backfillMissingTransactionSgdTotals,
  ensureHistoricalUsdSgdRates,
} from "@/lib/services/fx-sgd";
import { loadPortfolioFifoSnapshot } from "@/lib/services/holdings";
import { listPortfolios } from "@/lib/services/ledger";
import { getBenchmarkDisplayName } from "@/lib/services/watchlist";
import { formatSymbolForDisplay } from "@/lib/transactions/form-logic";

export const DEFAULT_BENCHMARK_PRESETS = ["^GSPC", "^IXIC", "^DJI", "^STI"] as const;

export type AllocationDimension =
  | "instrument"
  | "assetClass"
  | "sector"
  | "currency"
  | "region";

export interface AllocationSlice {
  key: string;
  label: string;
  valueInBase: string;
  percent: string;
  colorIndex: number;
}

export interface PeriodExtremeView {
  period: string;
  percent: string;
}

export interface DataQualityIssue {
  kind:
    | "missing_price"
    | "missing_timeline_history"
    | "missing_fx"
    | "missing_sector"
    | "zero_cost_buy"
    | "crypto_excluded";
  severity: "warning" | "info";
  symbol: string | null;
  displaySymbol: string | null;
  title: string;
  description: string;
  actionHref?: string;
  actionLabel?: string;
}

export interface MoverViewRow {
  symbol: string;
  displaySymbol: string;
  name: string | null;
  currency: string;
  unitPrice: string | null;
  marketValueInBase: string | null;
  dayChangeInBase: string | null;
  dayChangePercent: string | null;
  unrealizedPnlInBase: string | null;
  unrealizedPnlPercent: string | null;
  totalReturnInBase: string | null;
  totalReturnPercent: string | null;
}

export interface DividendSummaryData {
  totalDividendsInBase: string;
  trailing12MonthsInBase: string;
  projectedAnnualIncomeInBase: string | null;
  holdingsWithYieldCount: number;
  openHoldingsCount: number;
}

export interface BenchmarkSeriesData {
  symbol: string;
  displaySymbol: string;
  name: string;
  nativeCurrency: string;
  comparisonCurrency: "SGD" | "USD";
  status: "ok" | "unavailable";
  unavailableReason?: string;
  rebasedSeries: { date: string; value: string }[];
  periodReturns: Record<PeriodReturnKey, string | null>;
  cumulativeReturnPercent: string | null;
  annualizedReturnPercent: string | null;
  annualizedVolatilityPercent: string | null;
  sharpeRatio: string | null;
  drawdown: {
    points: { date: string; drawdownPercent: string }[];
    maxDrawdownPercent: string | null;
    peakDate: string | null;
    troughDate: string | null;
    recoveryDate: string | null;
    currentDrawdownPercent: string | null;
  };
  betaVsPortfolio: string | null;
  correlationVsPortfolio: string | null;
  alphaPercentVsPortfolio: string | null;
  overlapDays: number;
  sameCashFlows: SameCashFlowsSimulationResult | null;
}

export interface PortfolioAnalyticsSnapshot {
  /** True when zero transactions exist across ANY holdings portfolio (first-time onboarding). */
  accountHasNoTransactions: boolean;
  /** True when zero transactions exist in the currently filtered scope. */
  isEmpty: boolean;
  asOfDate: string;
  scope: {
    portfolioFilterId: string;
    portfolioName: string;
    currency: "SGD" | "USD";
    riskFreeRate: string;
    riskFreeRatePercent: string;
    dividendMode: "cash" | "shares";
    costBasisMethod: "FIFO";
    defaultBenchmark: string;
  };
  portfolios: Portfolio[];
  settings: Settings;
  market: CombinedMarketOverview;
  fxUsdToSgd: ExchangeRateSnapshot | null;
  quotes: Record<string, ResolvedInstrumentQuote>;
  summary: HoldingsOverviewSummary;
  holdings: ValuedHoldingRow[];
  timeline: {
    points: {
      date: string;
      portfolioValue: string;
      openCostBasis: string;
      netCashInvested: string;
      twrIndex: string | null;
    }[];
    firstTransactionDate: string | null;
    lastValuationDate: string | null;
    totalDepositsInBase: string;
    totalWithdrawalsAndDividendsInBase: string;
    excludedUnpricedSymbols: string[];
  };
  performance: {
    xirrPercent: string | null;
    cumulativeTwrPercent: string | null;
    annualizedTwrPercent: string | null;
    periodReturns: Record<PeriodReturnKey, string | null>;
    volatilityPercent: string | null;
    sharpeRatio: string | null;
    bestDay: PeriodExtremeView | null;
    worstDay: PeriodExtremeView | null;
    bestMonth: PeriodExtremeView | null;
    worstMonth: PeriodExtremeView | null;
    closedTradeCount: number;
    winningTradeCount: number;
    winRatePercent: string | null;
    drawdown: {
      points: { date: string; drawdownPercent: string }[];
      maxDrawdownPercent: string | null;
      peakDate: string | null;
      troughDate: string | null;
      recoveryDate: string | null;
      currentDrawdownPercent: string | null;
    };
  };
  allocations: Record<AllocationDimension, AllocationSlice[]>;
  movers: {
    topGainersToday: MoverViewRow[];
    topLosersToday: MoverViewRow[];
    topGainersAllTime: MoverViewRow[];
    topLosersAllTime: MoverViewRow[];
  };
  dividends: DividendSummaryData;
  dataQuality: DataQualityIssue[];
  benchmarks: Record<string, BenchmarkSeriesData>;
  requestedBenchmarks: string[];
}

export interface PortfolioAnalyticsOptions {
  portfolioId?: string;
  currency?: "SGD" | "USD";
  benchmarks?: string[];
  includeBenchmarks?: boolean;
  includeFundamentals?: boolean;
  forceRefresh?: boolean;
  /** Resolve quickly from memory & DB caches for instant scope/currency switching. */
  cacheOnly?: boolean;
  db?: Database;
  now?: Date;
  fetchImpl?: typeof fetch;
}

const DAILY_BAR_CONCURRENCY = 10;

function addCalendarDays(isoDate: string, deltaDays: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().slice(0, 10);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function runWorker(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await worker(items[idx]);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => runWorker(),
  );
  await Promise.all(workers);
  return results;
}

function emptyPeriodReturns(): Record<PeriodReturnKey, string | null> {
  return {
    "1D": null,
    "1W": null,
    "1M": null,
    "3M": null,
    "6M": null,
    YTD: null,
    "1Y": null,
    "3Y": null,
    "5Y": null,
    ALL: null,
  };
}

function formatPeriodReturns(
  raw: Record<PeriodReturnKey, DecimalValue | null>,
): Record<PeriodReturnKey, string | null> {
  return {
    "1D": toNullableDecimalString(raw["1D"], 2),
    "1W": toNullableDecimalString(raw["1W"], 2),
    "1M": toNullableDecimalString(raw["1M"], 2),
    "3M": toNullableDecimalString(raw["3M"], 2),
    "6M": toNullableDecimalString(raw["6M"], 2),
    YTD: toNullableDecimalString(raw.YTD, 2),
    "1Y": toNullableDecimalString(raw["1Y"], 2),
    "3Y": toNullableDecimalString(raw["3Y"], 2),
    "5Y": toNullableDecimalString(raw["5Y"], 2),
    ALL: toNullableDecimalString(raw.ALL, 2),
  };
}

function mapAssetTypeLabel(assetType: string): string {
  switch (assetType) {
    case "equity":
      return "Equities";
    case "etf":
      return "ETFs";
    case "reit":
      return "REITs";
    case "crypto":
      return "Crypto";
    case "index":
      return "Indices";
    default:
      return "Other";
  }
}

function mapRegionLabel(
  symbol: string,
  exchangeCode: string | null,
  assetType?: string,
): string {
  if (assetType === "crypto" || symbol.toUpperCase().endsWith("-USD")) {
    return "Crypto";
  }
  const upper = symbol.trim().toUpperCase();
  if (upper.endsWith(".HK")) return "Hong Kong";
  if (upper.endsWith(".L")) return "United Kingdom";
  if (upper.endsWith(".T")) return "Japan";
  if (upper.endsWith(".AX")) return "Australia";
  if (upper.endsWith(".TO")) return "Canada";
  const region = inferMarketRegion(symbol, exchangeCode);
  return region === "SG" ? "Singapore (SGX)" : "United States";
}

function groupAllocationSlices(
  entries: { key: string; label: string; value: DecimalValue }[],
  totalValue: DecimalValue,
  capSlices?: number,
): AllocationSlice[] {
  if (!totalValue.gt(ZERO) || entries.length === 0) {
    return [];
  }

  const combined = new Map<string, { label: string; value: DecimalValue }>();
  for (const entry of entries) {
    if (!entry.value.gt(ZERO)) {
      continue;
    }
    const existing = combined.get(entry.key);
    if (existing) {
      existing.value = existing.value.plus(entry.value);
    } else {
      combined.set(entry.key, { label: entry.label, value: entry.value });
    }
  }

  const sorted = [...combined.entries()]
    .map(([key, val]) => ({ key, label: val.label, value: val.value }))
    .sort((a, b) => b.value.cmp(a.value));

  const slicesSource =
    capSlices && sorted.length > capSlices
      ? [
          ...sorted.slice(0, capSlices - 1),
          {
            key: "__other__",
            label: `Other (${sorted.length - (capSlices - 1)})`,
            value: sorted
              .slice(capSlices - 1)
              .reduce((acc, item) => acc.plus(item.value), ZERO),
          },
        ]
      : sorted;

  return slicesSource.map((item, idx) => {
    const pct = safeDivide(item.value.mul(HUNDRED), totalValue) ?? ZERO;
    return {
      key: item.key,
      label: item.label,
      valueInBase: toDecimalString(item.value, 2),
      percent: toDecimalString(pct, 2),
      colorIndex: idx,
    };
  });
}

function toMoverViewRow(row: ValuedHoldingRow): MoverViewRow {
  return {
    symbol: row.symbol,
    displaySymbol: formatSymbolForDisplay(row.symbol),
    name: row.name,
    currency: row.currency,
    unitPrice: row.unitPrice,
    marketValueInBase: row.marketValueInBase,
    dayChangeInBase: row.dayChangeInBase,
    dayChangePercent: row.dayChangePercent,
    unrealizedPnlInBase: row.unrealizedPnlInBase,
    unrealizedPnlPercent: row.unrealizedPnlPercent,
    totalReturnInBase: row.totalReturnInBase,
    totalReturnPercent: row.totalReturnPercent,
  };
}

function buildRebasedBenchmarkSeries(params: {
  benchmarkCalendarEntries: [string, DecimalValue][];
  anchorDate: string | null;
}): { date: string; value: string }[] {
  if (params.benchmarkCalendarEntries.length === 0) {
    return [];
  }

  let anchorIdx = 0;
  if (params.anchorDate) {
    // Anchor on the latest benchmark trading day on or before portfolio's first active day.
    let foundIdx = -1;
    for (let i = 0; i < params.benchmarkCalendarEntries.length; i += 1) {
      if (params.benchmarkCalendarEntries[i][0] <= params.anchorDate) {
        foundIdx = i;
      } else {
        break;
      }
    }
    anchorIdx = foundIdx >= 0 ? foundIdx : 0;
  }

  const baseClose = params.benchmarkCalendarEntries[anchorIdx][1];
  if (!baseClose.gt(ZERO)) {
    return [];
  }

  const out: { date: string; value: string }[] = [];
  for (let i = anchorIdx; i < params.benchmarkCalendarEntries.length; i += 1) {
    const [date, close] = params.benchmarkCalendarEntries[i];
    const rebased = close.div(baseClose).mul(HUNDRED).toDecimalPlaces(4);
    out.push({
      date,
      value: toDecimalString(rebased, 4),
    });
  }
  return out;
}

/**
 * Computes the comprehensive portfolio analytics & benchmark snapshot used by
 * `/dashboard`, `/benchmarks`, and `GET /api/analytics`.
 */
export async function computePortfolioAnalytics(
  options: PortfolioAnalyticsOptions = {},
): Promise<PortfolioAnalyticsSnapshot> {
  const database = options.db ?? (await getDb());
  const now = options.now ?? new Date();
  const asOfDate = getSingaporeDateString(now);
  const market = getCombinedMarketOverview(now);

  if (!options.cacheOnly) {
    await backfillMissingTransactionSgdTotals({
      db: database,
      fetchImpl: options.fetchImpl,
    });
  }

  const requestedCurrencyOverride =
    options.currency === "USD"
      ? "USD"
      : options.currency === "SGD"
        ? "SGD"
        : undefined;

  const [allPortfolios, fifoSnapshot] = await Promise.all([
    listPortfolios(database),
    loadPortfolioFifoSnapshot({
      baseCurrencyOverride: requestedCurrencyOverride,
      db: database,
    }),
  ]);
  const appSettings = fifoSnapshot.appSettings;
  const comparisonCurrency: "SGD" | "USD" =
    fifoSnapshot.baseCurrency === "USD" ? "USD" : "SGD";

  const holdingsPortfolios = allPortfolios.filter((p) => p.type === "holdings");

  const requestedFilterId = options.portfolioId?.trim() || "all";
  const matchedPortfolio =
    requestedFilterId === "all"
      ? null
      : holdingsPortfolios.find((p) => p.id === requestedFilterId) ?? null;
  const portfolioFilterId = matchedPortfolio ? matchedPortfolio.id : "all";
  const portfolioName = matchedPortfolio
    ? matchedPortfolio.name
    : "All Portfolios";

  const requestedBenchmarks = [
    ...new Set(
      (options.benchmarks?.length
        ? options.benchmarks
        : [
            ...DEFAULT_BENCHMARK_PRESETS,
            appSettings.defaultBenchmark,
          ]
      )
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];

  const scopedTimelineBuckets =
    portfolioFilterId === "all"
      ? fifoSnapshot.timelineBuckets
      : fifoSnapshot.timelineBuckets.filter(
          (b) => b.portfolioId === portfolioFilterId,
        );

  const scopedSerializedBuckets =
    portfolioFilterId === "all"
      ? fifoSnapshot.buckets
      : fifoSnapshot.buckets.filter((b) => b.portfolioId === portfolioFilterId);

  const accountHasNoTransactions = fifoSnapshot.holdingsTransactionCount === 0;
  const isEmpty = scopedTimelineBuckets.every(
    (b) => b.transactions.length === 0,
  );

  // Determine earliest transaction date + ensure at least 1Y+ lookback for benchmark periods.
  let earliestTxDate: string | null = null;
  for (const b of scopedTimelineBuckets) {
    for (const tx of b.transactions) {
      const localDate = formatInstantInOffset(
        tx.executedAt,
        tx.originalOffset ?? "+0800",
      ).localDate;
      if (earliestTxDate === null || localDate < earliestTxDate) {
        earliestTxDate = localDate;
      }
    }
  }

  const benchmarkDefaultStart = addCalendarDays(asOfDate, -1835);
  const benchmarkFetchStart =
    earliestTxDate && earliestTxDate < benchmarkDefaultStart
      ? earliestTxDate
      : benchmarkDefaultStart;

  const fxFetchStart = earliestTxDate
    ? earliestTxDate < benchmarkFetchStart
      ? earliestTxDate
      : benchmarkFetchStart
    : benchmarkFetchStart;

  // Deduplicate portfolio instruments needing daily bars (skip crypto & delisted & known not-found).
  const portfolioInstrumentDateBounds = new Map<
    string,
    {
      instrumentId: string;
      symbol: string;
      earliestDate: string;
      latestTxDate: string;
      hasOpenPosition: boolean;
      assetType: string;
      isDelisted: boolean;
      isNotFound: boolean;
    }
  >();

  for (const b of scopedTimelineBuckets) {
    const ser = scopedSerializedBuckets.find(
      (s) =>
        s.portfolioId === b.portfolioId && s.instrumentId === b.instrumentId,
    );
    const assetType = ser?.assetType ?? "unknown";
    const isBucketOpen = ser ? toDecimal(ser.sharesHeld).gt(ZERO) : false;
    const isBucketNotFound = Boolean(ser?.priceNotFound);
    let minDate = asOfDate;
    let maxDate = "";
    for (const tx of b.transactions) {
      const d = formatInstantInOffset(
        tx.executedAt,
        tx.originalOffset ?? "+0800",
      ).localDate;
      if (d < minDate) {
        minDate = d;
      }
      if (d > maxDate) {
        maxDate = d;
      }
    }

    const existing = portfolioInstrumentDateBounds.get(b.instrumentId);
    if (!existing) {
      portfolioInstrumentDateBounds.set(b.instrumentId, {
        instrumentId: b.instrumentId,
        symbol: b.symbol,
        earliestDate: minDate,
        latestTxDate: maxDate || minDate,
        hasOpenPosition: isBucketOpen,
        assetType,
        isDelisted: b.isDelisted,
        isNotFound: isBucketNotFound,
      });
    } else {
      if (minDate < existing.earliestDate) {
        existing.earliestDate = minDate;
      }
      if (maxDate > existing.latestTxDate) {
        existing.latestTxDate = maxDate;
      }
      if (isBucketOpen) {
        existing.hasOpenPosition = true;
      }
      if (isBucketNotFound) {
        existing.isNotFound = true;
      }
    }
  }

  const portfolioSymbolsToFetch = [
    ...portfolioInstrumentDateBounds.values(),
  ].filter(
    (item) =>
      item.assetType !== "crypto" && !item.isDelisted && !item.isNotFound,
  );

  const includeBenchmarks = options.includeBenchmarks ?? true;
  const benchmarkSymbolsToFetch = includeBenchmarks ? requestedBenchmarks : [];

  // 2. Sync FX history, daily bars (portfolio + benchmarks), live FX, and live quotes.
  // Sample every 14 days across `[fxFetchStart .. asOfDate]` so multi-year stretches (3Y/5Y/MAX)
  // detect and backfill interior gaps instead of falling back to spot FX.
  const fxSampleDates = [fxFetchStart, asOfDate];
  for (
    let cursor = addCalendarDays(fxFetchStart, 14);
    cursor < asOfDate;
    cursor = addCalendarDays(cursor, 14)
  ) {
    fxSampleDates.push(cursor);
  }
  if (earliestTxDate) {
    fxSampleDates.push(earliestTxDate);
  }

  const allQuoteSymbols = [
    ...new Set([
      ...scopedSerializedBuckets.map((b) => b.symbol),
      ...benchmarkSymbolsToFetch,
    ]),
  ];

  const openNonCryptoSymbols = [
    ...new Set(
      scopedSerializedBuckets
        .filter(
          (b) =>
            toDecimal(b.sharesHeld).gt(ZERO) &&
            b.assetType !== "crypto" &&
            !b.isDelisted &&
            !b.priceNotFound,
        )
        .map((b) => b.symbol),
    ),
  ];

  const liveQuoteSymbolSet = new Set([
    ...openNonCryptoSymbols,
    ...benchmarkSymbolsToFetch,
  ]);
  const liveQuoteSymbols = [...liveQuoteSymbolSet];
  const cachedOnlyQuoteSymbols = allQuoteSymbols.filter(
    (sym) => !liveQuoteSymbolSet.has(sym),
  );

  const cachedLiveFxFallback: ExchangeRateSnapshot | null =
    getCachedUsdToSgdSnapshot() ??
    (fifoSnapshot.latestCachedUsdSgd
      ? {
          from: "USD",
          to: "SGD",
          rate: toDecimalString(toDecimal(fifoSnapshot.latestCachedUsdSgd), 6),
          effectiveDate: asOfDate,
          asOf: now.toISOString(),
          source: "frankfurter",
          label: "Cached FX rate",
          isHistorical: false,
        }
      : null);

  // Run FX sync, live FX, batch quotes, portfolio daily bars, benchmark daily
  // bars, and open-holding fundamentals concurrently rather than sequentially.
  const [
    fxSyncResult,
    liveFx,
    quotes,
    ,
    benchmarkBarSettled,
    fundamentalsSettled,
    benchmarkInstrRows,
  ] = await Promise.all([
    ensureHistoricalUsdSgdRates({
      dates: fxSampleDates,
      database,
      fetchImpl: options.fetchImpl,
      cacheOnly: options.cacheOnly,
      forceSync: options.forceRefresh,
    }),
    options.cacheOnly && cachedLiveFxFallback
      ? Promise.resolve(cachedLiveFxFallback)
      : fetchExchangeRateToSgd({
          from: "USD",
          now,
          skipCache: options.forceRefresh,
          fetchImpl: options.fetchImpl,
        }).catch((): ExchangeRateSnapshot | null => cachedLiveFxFallback),
    resolveQuotesForSymbols({
      symbols: liveQuoteSymbols,
      db: database,
      now,
      includeSparklines: false,
      skipCache: options.forceRefresh,
      cacheOnly: options.cacheOnly,
      concurrency: DAILY_BAR_CONCURRENCY,
      fetchImpl: options.fetchImpl,
    }).then(async (liveMap) => {
      if (cachedOnlyQuoteSymbols.length === 0) {
        return liveMap;
      }
      const cachedMap = await resolveQuotesForSymbols({
        symbols: cachedOnlyQuoteSymbols,
        db: database,
        now,
        includeSparklines: false,
        cacheOnly: true,
        concurrency: DAILY_BAR_CONCURRENCY,
      });
      return { ...cachedMap, ...liveMap };
    }),
    options.cacheOnly && !options.forceRefresh
      ? Promise.resolve([])
      : mapWithConcurrency(
          portfolioSymbolsToFetch,
          DAILY_BAR_CONCURRENCY,
          (item) =>
            ensureInstrumentDailyBars({
              symbol: item.symbol,
              startDate: item.earliestDate,
              // Closed positions never change valuation after their last transaction date.
              endDate: item.hasOpenPosition
                ? asOfDate
                : item.latestTxDate || asOfDate,
              forceRefresh: options.forceRefresh,
              cacheOnly: options.cacheOnly,
              db: database,
              now,
              fetchImpl: options.fetchImpl,
            }),
        ),
    !(options.cacheOnly && !options.forceRefresh) &&
    includeBenchmarks &&
    benchmarkSymbolsToFetch.length > 0
      ? mapWithConcurrency(
          benchmarkSymbolsToFetch,
          DAILY_BAR_CONCURRENCY,
          async (sym) => ({
            sym,
            res: await ensureInstrumentDailyBars({
              symbol: sym,
              startDate: benchmarkFetchStart,
              endDate: asOfDate,
              forceRefresh: options.forceRefresh,
              cacheOnly: options.cacheOnly,
              db: database,
              now,
              fetchImpl: options.fetchImpl,
            }),
          }),
        )
      : Promise.resolve([]),
    options.includeFundamentals && openNonCryptoSymbols.length > 0
      ? options.cacheOnly
        ? Promise.resolve(
            openNonCryptoSymbols.map((sym) => ({
              symbol: sym,
              fundamentals: getCachedInstrumentFundamentals(sym) ?? null,
            })),
          )
        : mapWithConcurrency(
            openNonCryptoSymbols,
            DAILY_BAR_CONCURRENCY,
            async (sym) => ({
              symbol: sym,
              fundamentals: await fetchInstrumentFundamentals(sym, {
                now,
                skipCache: options.forceRefresh,
                fetchImpl: options.fetchImpl,
              }).catch(() => null),
            }),
          )
      : Promise.resolve([]),
    benchmarkSymbolsToFetch.length > 0
      ? database
          .select()
          .from(instrument)
          .where(inArray(instrument.symbol, benchmarkSymbolsToFetch))
      : Promise.resolve([]),
  ]);

  const benchmarkBarResults = new Map<
    string,
    Awaited<ReturnType<typeof ensureInstrumentDailyBars>>
  >();
  for (const entry of benchmarkBarSettled) {
    benchmarkBarResults.set(entry.sym, entry.res);
  }

  const benchmarkInstrumentsBySymbol = new Map<
    string,
    typeof instrument.$inferSelect
  >();
  for (const row of benchmarkInstrRows) {
    benchmarkInstrumentsBySymbol.set(row.symbol, row);
  }

  // Merge live USD->SGD into an enriched FxRateBook for `asOfDate` valuation
  // Price bars and FX rows are independent reads, so fetch them concurrently.
  const relevantInstrumentIdsForBars = [
    ...new Set([
      ...portfolioInstrumentDateBounds.keys(),
      ...[...benchmarkBarResults.values()]
        .map((r) => r.instrumentId)
        .filter((id): id is string => Boolean(id)),
      ...benchmarkInstrRows.map((r) => r.id),
    ]),
  ];
  const [allFxRows, loadedPriceBarRows] = await Promise.all([
    liveFx ? database.select().from(fxRate) : Promise.resolve([]),
    relevantInstrumentIdsForBars.length > 0
      ? database
          .select()
          .from(priceBar)
          .where(inArray(priceBar.instrumentId, relevantInstrumentIdsForBars))
      : Promise.resolve([]),
  ]);
  const effectiveFxRateBook = liveFx
    ? new FxRateBook([
        ...allFxRows,
        {
          date: asOfDate,
          fromCurrency: "USD",
          toCurrency: "SGD",
          rate: liveFx.rate,
        },
      ])
    : fxSyncResult.fxBook;

  // Index the persisted `price_bar` rows loaded above for portfolio instruments & benchmarks
  const dailyBarsByInstrument = new Map<string, Map<string, string>>();
  for (const row of loadedPriceBarRows) {
    let map = dailyBarsByInstrument.get(row.instrumentId);
    if (!map) {
      map = new Map<string, string>();
      dailyBarsByInstrument.set(row.instrumentId, map);
    }
    map.set(row.date, row.close);
  }

  // 3. Evaluate current Holdings overview & optional Fundamentals
  const { rows: valuedHoldings, summary } = buildValuedHoldings({
    buckets: scopedSerializedBuckets,
    portfolioFilterId,
    quotes,
    usdToSgdRate: liveFx?.rate ?? fifoSnapshot.latestCachedUsdSgd,
    baseCurrency: comparisonCurrency,
  });

  const fundamentalsBySymbol = new Map<string, InstrumentFundamentals>();
  for (const item of fundamentalsSettled) {
    if (item.fundamentals && item.fundamentals.status === "ok") {
      fundamentalsBySymbol.set(item.symbol, item.fundamentals);
    }
  }

  // 4. Reconstruct Historical Portfolio Timeline + Compute TWR, XIRR, Drawdown, Risk
  const livePricesByInstrument = new Map<string, string>();
  for (const h of valuedHoldings) {
    const q = quotes[h.symbol];
    if (q && q.price !== null) {
      livePricesByInstrument.set(h.instrumentId, q.price);
    }
  }

  const timeline = isEmpty
    ? {
        points: [],
        twrInputs: [],
        xirrCashFlows: [],
        externalCashFlows: [],
        excludedUnpricedSymbols: [],
        firstTransactionDate: null,
        lastValuationDate: null,
        endingMarketValue: "0",
        totalDepositsInBase: "0",
        totalWithdrawalsAndDividendsInBase: "0",
      }
    : reconstructPortfolioTimeline({
        buckets: scopedTimelineBuckets,
        splitsByInstrument: fifoSnapshot.splitsByInstrument,
        dailyBarsByInstrument,
        livePricesByInstrument,
        fxBook: effectiveFxRateBook,
        fallbackUsdToSgd: liveFx?.rate ?? fifoSnapshot.latestCachedUsdSgd,
        baseCurrency: comparisonCurrency,
        dividendMode:
          appSettings.dividendMode === "shares" ? "shares" : "cash",
        asOfDate,
      });

  const twrResult = computeTimeWeightedReturn(timeline.twrInputs);
  const twrByDate = new Map(
    twrResult.points.map((pt) => [
      pt.date,
      pt.isActiveDay ? toDecimalString(pt.cumulativeIndex, 4) : null,
    ]),
  );

  const activeTwrSeries = twrResult.points
    .filter((pt) => pt.isActiveDay)
    .map((pt) => ({ date: pt.date, value: pt.cumulativeIndex }));

  const portfolioDailyReturns = twrResult.points
    .filter(
      (pt) =>
        pt.isActiveDay &&
        twrResult.firstActiveDate !== null &&
        pt.date > twrResult.firstActiveDate,
    )
    .map((pt) => ({ date: pt.date, dailyReturn: pt.dailyReturn }));

  const xirrValue =
    timeline.xirrCashFlows.length >= 2
      ? computeXirr(timeline.xirrCashFlows)
      : null;

  const periodReturnsRaw = computeHorizonReturns(activeTwrSeries, asOfDate, {
    allBaseValue: HUNDRED,
  });
  if (twrResult.cumulativeReturnPercent !== null) {
    periodReturnsRaw.ALL = twrResult.cumulativeReturnPercent;
  }
  const drawdownResult = computeDrawdownSeries(activeTwrSeries);
  const volatilityPct = computeAnnualizedVolatility(portfolioDailyReturns);
  const riskFreeDec = toDecimal(appSettings.riskFreeRate);
  const sharpeRatio = computeSharpeRatio({
    annualizedReturnFraction: twrResult.annualizedReturn,
    annualizedVolatilityPercent: volatilityPct,
    riskFreeRateFraction: riskFreeDec,
  });
  const bestWorst = computeBestWorstPeriods(portfolioDailyReturns);

  const closedTradeCount = valuedHoldings.reduce(
    (sum, h) => sum + h.closedTradeCount,
    0,
  );
  const winningTradeCount = valuedHoldings.reduce(
    (sum, h) => sum + h.winningTradeCount,
    0,
  );
  const winRate =
    closedTradeCount > 0
      ? safeDivide(
          toDecimal(winningTradeCount).mul(HUNDRED),
          toDecimal(closedTradeCount),
        )
      : null;

  // 5. Benchmarks Processing (all converted into `comparisonCurrency`!)
  const benchmarks: Record<string, BenchmarkSeriesData> = {};
  const fallbackFxDec = toOptionalDecimal(
    liveFx?.rate ?? fifoSnapshot.latestCachedUsdSgd,
  );

  for (const benchSym of benchmarkSymbolsToFetch) {
    const barSync = benchmarkBarResults.get(benchSym);
    const instrRecord = benchmarkInstrumentsBySymbol.get(benchSym);
    const nativeCurrency = (
      barSync?.currency ??
      instrRecord?.currency ??
      "USD"
    ).toUpperCase();
    const benchQuote = quotes[benchSym];

    const rawBarsMap =
      barSync?.instrumentId && dailyBarsByInstrument.get(barSync.instrumentId)
        ? dailyBarsByInstrument.get(barSync.instrumentId)!
        : instrRecord?.id && dailyBarsByInstrument.get(instrRecord.id)
          ? dailyBarsByInstrument.get(instrRecord.id)!
          : new Map<string, string>();

    const convertedClosesMap = new Map<string, DecimalValue>();
    for (const [barDate, rawClose] of rawBarsMap.entries()) {
      const closeDec = toOptionalDecimal(rawClose);
      if (!closeDec || !closeDec.gt(ZERO)) continue;
      let fxRateMult = lookupFxRate({
        fromCurrency: nativeCurrency,
        toCurrency: comparisonCurrency,
        date: barDate,
        rateBook: effectiveFxRateBook,
        maxLookbackDays: 14,
      }).rate;
      if (fxRateMult === null && fallbackFxDec) {
        if (nativeCurrency === "USD" && comparisonCurrency === "SGD") {
          fxRateMult = fallbackFxDec;
        } else if (nativeCurrency === "SGD" && comparisonCurrency === "USD") {
          fxRateMult = safeDivide(ONE, fallbackFxDec);
        }
      }
      if (fxRateMult && fxRateMult.gt(ZERO)) {
        convertedClosesMap.set(barDate, closeDec.mul(fxRateMult));
      }
    }

    if (benchQuote && benchQuote.price !== null) {
      const liveClose = toOptionalDecimal(benchQuote.price);
      if (liveClose && liveClose.gt(ZERO)) {
        let fxRateMult = lookupFxRate({
          fromCurrency: nativeCurrency,
          toCurrency: comparisonCurrency,
          date: asOfDate,
          rateBook: effectiveFxRateBook,
          maxLookbackDays: 14,
        }).rate;
        if (fxRateMult === null && fallbackFxDec) {
          if (nativeCurrency === "USD" && comparisonCurrency === "SGD") {
            fxRateMult = fallbackFxDec;
          } else if (
            nativeCurrency === "SGD" &&
            comparisonCurrency === "USD"
          ) {
            fxRateMult = safeDivide(ONE, fallbackFxDec);
          }
        }
        if (fxRateMult && fxRateMult.gt(ZERO)) {
          convertedClosesMap.set(asOfDate, liveClose.mul(fxRateMult));
        }
      }
    }

    const sortedBenchEntries = [...convertedClosesMap.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );

    if (sortedBenchEntries.length === 0) {
      benchmarks[benchSym] = {
        symbol: benchSym,
        displaySymbol: formatSymbolForDisplay(benchSym),
        name: benchQuote?.name ?? getBenchmarkDisplayName(benchSym),
        nativeCurrency,
        comparisonCurrency,
        status: "unavailable",
        unavailableReason:
          barSync?.unavailableReason ??
          "No historical bars available for benchmark.",
        rebasedSeries: [],
        periodReturns: emptyPeriodReturns(),
        cumulativeReturnPercent: null,
        annualizedReturnPercent: null,
        annualizedVolatilityPercent: null,
        sharpeRatio: null,
        drawdown: {
          points: [],
          maxDrawdownPercent: null,
          peakDate: null,
          troughDate: null,
          recoveryDate: null,
          currentDrawdownPercent: null,
        },
        betaVsPortfolio: null,
        correlationVsPortfolio: null,
        alphaPercentVsPortfolio: null,
        overlapDays: 0,
        sameCashFlows: null,
      };
      continue;
    }

    const rebasedSeries = buildRebasedBenchmarkSeries({
      benchmarkCalendarEntries: sortedBenchEntries,
      anchorDate: twrResult.firstActiveDate,
    });

    const benchFullSeries = sortedBenchEntries.map(([date, val]) => ({
      date,
      value: val,
    }));
    const benchPeriods = computeHorizonReturns(benchFullSeries, asOfDate);

    // Compute cumulative + CAGR over the aligned rebased span
    const firstRebased = rebasedSeries[0];
    const lastRebased = rebasedSeries[rebasedSeries.length - 1];
    const benchCumFraction =
      firstRebased && lastRebased
        ? safeDivide(
            toDecimal(lastRebased.value).minus(toDecimal(firstRebased.value)),
            toDecimal(firstRebased.value),
          )
        : null;
    if (twrResult.firstActiveDate && benchCumFraction !== null) {
      // Align ALL to the portfolio's active start date so every row matches Cum. TWR.
      benchPeriods.ALL = benchCumFraction.mul(HUNDRED);
    }
    const benchAnnFraction =
      firstRebased && lastRebased
        ? computeCagr(benchCumFraction, firstRebased.date, lastRebased.date)
        : null;

    const benchDailyReturns: { date: string; dailyReturn: DecimalValue }[] = [];
    for (let i = 1; i < sortedBenchEntries.length; i += 1) {
      const prev = sortedBenchEntries[i - 1][1];
      const curr = sortedBenchEntries[i][1];
      if (prev.gt(ZERO)) {
        const r = curr.minus(prev).div(prev);
        benchDailyReturns.push({
          date: sortedBenchEntries[i][0],
          dailyReturn: r,
        });
      }
    }

    const benchVolPct = computeAnnualizedVolatility(
      twrResult.firstActiveDate
        ? benchDailyReturns.filter(
            (pt) => pt.date > twrResult.firstActiveDate!,
          )
        : benchDailyReturns,
    );
    const benchSharpe = computeSharpeRatio({
      annualizedReturnFraction: benchAnnFraction,
      annualizedVolatilityPercent: benchVolPct,
      riskFreeRateFraction: riskFreeDec,
    });
    const benchDrawdown = computeDrawdownSeries(
      rebasedSeries.length >= 2 ? rebasedSeries : benchFullSeries,
    );

    const regression = computeBenchmarkRegression({
      portfolioReturns: portfolioDailyReturns,
      benchmarkReturns: benchDailyReturns,
      portfolioAnnualizedReturn: twrResult.annualizedReturn,
      benchmarkAnnualizedReturn: benchAnnFraction,
      riskFreeRateFraction: riskFreeDec,
    });

    const sameCashFlows = isEmpty
      ? null
      : computeSameCashFlowsSimulation({
          benchmarkSymbol: benchSym,
          portfolioSeries: timeline.points.map((p) => ({
            date: p.date,
            portfolioValue: p.portfolioValue,
          })),
          externalCashFlows: timeline.externalCashFlows,
          benchmarkPricesByDate: new Map(
            sortedBenchEntries.map(([d, v]) => [d, toDecimalString(v, 8)]),
          ),
        });

    benchmarks[benchSym] = {
      symbol: benchSym,
      displaySymbol: formatSymbolForDisplay(benchSym),
      name: benchQuote?.name ?? getBenchmarkDisplayName(benchSym),
      nativeCurrency,
      comparisonCurrency,
      status: "ok",
      rebasedSeries,
      periodReturns: formatPeriodReturns(benchPeriods),
      cumulativeReturnPercent: benchCumFraction
        ? toDecimalString(benchCumFraction.mul(HUNDRED), 2)
        : null,
      annualizedReturnPercent: benchAnnFraction
        ? toDecimalString(benchAnnFraction.mul(HUNDRED), 2)
        : null,
      annualizedVolatilityPercent: toNullableDecimalString(benchVolPct, 2),
      sharpeRatio: toNullableDecimalString(benchSharpe, 2),
      drawdown: {
        points: benchDrawdown.points.map((pt) => ({
          date: pt.date,
          drawdownPercent: toDecimalString(pt.drawdownPercent, 2),
        })),
        maxDrawdownPercent: toNullableDecimalString(
          benchDrawdown.maxDrawdownPercent,
          2,
        ),
        peakDate: benchDrawdown.peakDate,
        troughDate: benchDrawdown.troughDate,
        recoveryDate: benchDrawdown.recoveryDate,
        currentDrawdownPercent: toNullableDecimalString(
          benchDrawdown.currentDrawdownPercent,
          2,
        ),
      },
      betaVsPortfolio: toNullableDecimalString(regression.beta, 2),
      correlationVsPortfolio: toNullableDecimalString(regression.correlation, 2),
      alphaPercentVsPortfolio: toNullableDecimalString(
        regression.alphaPercent,
        2,
      ),
      overlapDays: regression.sampleSize,
      sameCashFlows,
    };
  }

  // 6. Allocation Breakdown (5 dimensions over priced open holdings)
  const pricedOpenHoldings = valuedHoldings.filter(
    (h) => h.isOpenPosition && toOptionalDecimal(h.marketValueInBase)?.gt(ZERO),
  );
  const totalOpenMvInBase = pricedOpenHoldings.reduce(
    (acc, h) => acc.plus(toDecimal(h.marketValueInBase!)),
    ZERO,
  );

  const allocations: Record<AllocationDimension, AllocationSlice[]> = {
    instrument: groupAllocationSlices(
      pricedOpenHoldings.map((h) => ({
        key: h.symbol,
        label: h.name
          ? `${formatSymbolForDisplay(h.symbol)} (${h.name})`
          : formatSymbolForDisplay(h.symbol),
        value: toDecimal(h.marketValueInBase!),
      })),
      totalOpenMvInBase,
      9,
    ),
    assetClass: groupAllocationSlices(
      pricedOpenHoldings.map((h) => ({
        key: h.assetType,
        label: mapAssetTypeLabel(h.assetType),
        value: toDecimal(h.marketValueInBase!),
      })),
      totalOpenMvInBase,
    ),
    sector: groupAllocationSlices(
      pricedOpenHoldings.map((h) => {
        const fundSector = fundamentalsBySymbol.get(h.symbol)?.sector;
        const label =
          fundSector && fundSector.trim() !== ""
            ? fundSector.trim()
            : h.assetType === "etf"
              ? "ETFs / Index Funds"
              : h.assetType === "reit"
                ? "Real Estate (REITs)"
                : h.assetType === "crypto"
                  ? "Digital Assets"
                  : "Unclassified";
        return {
          key: label.toLowerCase().replace(/\s+/g, "-"),
          label,
          value: toDecimal(h.marketValueInBase!),
        };
      }),
      totalOpenMvInBase,
    ),
    currency: groupAllocationSlices(
      pricedOpenHoldings.map((h) => ({
        key: h.currency.toUpperCase(),
        label: h.currency.toUpperCase(),
        value: toDecimal(h.marketValueInBase!),
      })),
      totalOpenMvInBase,
    ),
    region: groupAllocationSlices(
      pricedOpenHoldings.map((h) => {
        const region = mapRegionLabel(h.symbol, h.exchangeCode, h.assetType);
        return {
          key: region.toLowerCase().replace(/\s+/g, "-"),
          label: region,
          value: toDecimal(h.marketValueInBase!),
        };
      }),
      totalOpenMvInBase,
    ),
  };

  // 7. Top Movers (Today + All-Time)
  const pricedWithDayChange = pricedOpenHoldings.filter(
    (h) => h.dayChangePercent !== null,
  );
  const topGainersToday = [...pricedWithDayChange]
    .filter((h) => toDecimal(h.dayChangePercent!).gt(ZERO))
    .sort((a, b) =>
      toDecimal(b.dayChangePercent!).cmp(toDecimal(a.dayChangePercent!)),
    )
    .slice(0, 5)
    .map(toMoverViewRow);

  const topLosersToday = [...pricedWithDayChange]
    .filter((h) => toDecimal(h.dayChangePercent!).lt(ZERO))
    .sort((a, b) =>
      toDecimal(a.dayChangePercent!).cmp(toDecimal(b.dayChangePercent!)),
    )
    .slice(0, 5)
    .map(toMoverViewRow);

  const pricedWithTotalReturn = pricedOpenHoldings.filter(
    (h) => h.unrealizedPnlPercent !== null,
  );
  const topGainersAllTime = [...pricedWithTotalReturn]
    .filter((h) => toDecimal(h.unrealizedPnlPercent!).gt(ZERO))
    .sort((a, b) =>
      toDecimal(b.unrealizedPnlPercent!).cmp(
        toDecimal(a.unrealizedPnlPercent!),
      ),
    )
    .slice(0, 5)
    .map(toMoverViewRow);

  const topLosersAllTime = [...pricedWithTotalReturn]
    .filter((h) => toDecimal(h.unrealizedPnlPercent!).lt(ZERO))
    .sort((a, b) =>
      toDecimal(a.unrealizedPnlPercent!).cmp(
        toDecimal(b.unrealizedPnlPercent!),
      ),
    )
    .slice(0, 5)
    .map(toMoverViewRow);

  // 8. Dividend Summary (Total, TTM, Projected Annual Income)
  const ttmStartDate = addCalendarDays(asOfDate, -365);
  let ttmDividends = ZERO;
  for (const bucket of scopedTimelineBuckets) {
    for (const tx of bucket.transactions) {
      if (tx.type !== "Dividend") continue;
      const localDate = formatInstantInOffset(
        tx.executedAt,
        tx.originalOffset ?? "+0800",
      ).localDate;
      if (localDate < ttmStartDate || localDate > asOfDate) continue;
      const qty = toDecimal(tx.quantity);
      const price = toDecimal(tx.price);
      const gross =
        appSettings.dividendMode === "shares" ? qty.mul(price) : qty;
      const comm = computeCommissionAmount(gross, {
        value: toDecimal(tx.commissionValue ?? ZERO),
        isPercent: Boolean(tx.commissionIsPercent),
      });
      const net = gross.minus(comm);
      const fx =
        lookupFxRate({
          fromCurrency: bucket.currency,
          toCurrency: comparisonCurrency,
          date: localDate,
          explicitRate: tx.purchaseFxRate,
          explicitCurrencies: tx.purchaseFxCurrencies,
          rateBook: effectiveFxRateBook,
          maxLookbackDays: 14,
        }).rate ??
        (fallbackFxDec &&
        bucket.currency.toUpperCase() === "USD" &&
        comparisonCurrency === "SGD"
          ? fallbackFxDec
          : ONE);
      if (net.gt(ZERO)) {
        ttmDividends = ttmDividends.plus(net.mul(fx));
      }
    }
  }

  let projectedAnnualIncome = ZERO;
  let holdingsWithYieldCount = 0;
  for (const h of pricedOpenHoldings) {
    const fund = fundamentalsBySymbol.get(h.symbol);
    const yieldPct = toOptionalDecimal(fund?.dividendYieldPercent);
    const mv = toOptionalDecimal(h.marketValueInBase);
    if (yieldPct && yieldPct.gt(ZERO) && mv && mv.gt(ZERO)) {
      projectedAnnualIncome = projectedAnnualIncome.plus(
        mv.mul(yieldPct).div(HUNDRED),
      );
      holdingsWithYieldCount += 1;
    }
  }

  // 9. Honest Data Quality Panel
  const dataQuality: DataQualityIssue[] = [];
  for (const sym of summary.unpricedOpenSymbols) {
    const holding = valuedHoldings.find((h) => h.symbol === sym);
    const isCrypto = holding?.assetType === "crypto";
    dataQuality.push({
      kind: isCrypto ? "crypto_excluded" : "missing_price",
      severity: "warning",
      symbol: sym,
      displaySymbol: formatSymbolForDisplay(sym),
      title: isCrypto
        ? `${formatSymbolForDisplay(sym)} crypto quote excluded`
        : `${formatSymbolForDisplay(sym)} has no market price`,
      description: isCrypto
        ? "External crypto price fetching is disabled. Enter a manual price override to include this asset in portfolio valuation and charts."
        : "Provider quotes and historical bars are unavailable. Set a manual price override on the stock page if this holding has value.",
      actionHref: `/holdings/${encodeURIComponent(sym)}`,
      actionLabel: "Set price",
    });
  }

  for (const sym of timeline.excludedUnpricedSymbols) {
    if (summary.unpricedOpenSymbols.includes(sym)) continue;
    dataQuality.push({
      kind: "missing_timeline_history",
      severity: "info",
      symbol: sym,
      displaySymbol: formatSymbolForDisplay(sym),
      title: `${formatSymbolForDisplay(sym)} excluded from time-series return`,
      description:
        "Historical price bars were unavailable for this symbol, so it is omitted from historical TWR and drawdown curves rather than valued as $0.",
      actionHref: `/holdings/${encodeURIComponent(sym)}`,
      actionLabel: "Inspect",
    });
  }

  if (fifoSnapshot.nonSgdMissingFxCount > 0) {
    dataQuality.push({
      kind: "missing_fx",
      severity: "warning",
      symbol: null,
      displaySymbol: null,
      title: `${fifoSnapshot.nonSgdMissingFxCount} non-SGD transaction(s) missing cached FX snapshot`,
      description:
        "Historical exchange-rate lookup fell back to the latest available rate or could not be fetched while offline.",
      actionHref: "/transactions",
      actionLabel: "Review ledger",
    });
  }

  const totalZeroCostBuys = valuedHoldings.reduce(
    (sum, h) => sum + h.zeroCostBuyCount,
    0,
  );
  if (totalZeroCostBuys > 0) {
    dataQuality.push({
      kind: "zero_cost_buy",
      severity: "info",
      symbol: null,
      displaySymbol: null,
      title: `${totalZeroCostBuys} zero-cost Buy transaction(s)`,
      description:
        "Recorded at $0.00 unit price (such as vested grants or transfers). Open cost basis reflects 0.00; infinite percentage return is hidden where undefined.",
      actionHref: "/transactions",
      actionLabel: "View ledger",
    });
  }

  const unclassifiedOpenEquities = pricedOpenHoldings.filter(
    (h) =>
      h.assetType === "equity" &&
      !fundamentalsBySymbol.get(h.symbol)?.sector &&
      options.includeFundamentals,
  );
  if (unclassifiedOpenEquities.length > 0) {
    dataQuality.push({
      kind: "missing_sector",
      severity: "info",
      symbol: null,
      displaySymbol: null,
      title: `${unclassifiedOpenEquities.length} equity holding(s) lack GICS sector`,
      description:
        "Free Yahoo chart endpoints do not supply company sector tags without an optional Finnhub API key, so they appear as Unclassified in Sector breakdown.",
    });
  }

  return {
    accountHasNoTransactions,
    isEmpty,
    asOfDate,
    scope: {
      portfolioFilterId,
      portfolioName,
      currency: comparisonCurrency,
      riskFreeRate: appSettings.riskFreeRate,
      riskFreeRatePercent: toDecimalString(riskFreeDec.mul(HUNDRED), 2),
      dividendMode: appSettings.dividendMode === "shares" ? "shares" : "cash",
      costBasisMethod: "FIFO",
      defaultBenchmark: appSettings.defaultBenchmark,
    },
    portfolios: holdingsPortfolios,
    settings: appSettings,
    market,
    fxUsdToSgd: liveFx,
    quotes,
    summary,
    holdings: valuedHoldings,
    timeline: {
      points: timeline.points.map((pt) => ({
        ...pt,
        twrIndex: twrByDate.get(pt.date) ?? null,
      })),
      firstTransactionDate: timeline.firstTransactionDate,
      lastValuationDate: timeline.lastValuationDate,
      totalDepositsInBase: timeline.totalDepositsInBase,
      totalWithdrawalsAndDividendsInBase:
        timeline.totalWithdrawalsAndDividendsInBase,
      excludedUnpricedSymbols: timeline.excludedUnpricedSymbols,
    },
    performance: {
      xirrPercent: xirrValue
        ? toDecimalString(xirrValue.mul(HUNDRED), 2)
        : null,
      cumulativeTwrPercent: toNullableDecimalString(
        twrResult.cumulativeReturnPercent,
        2,
      ),
      annualizedTwrPercent: toNullableDecimalString(
        twrResult.annualizedReturnPercent,
        2,
      ),
      periodReturns: formatPeriodReturns(periodReturnsRaw),
      volatilityPercent: toNullableDecimalString(volatilityPct, 2),
      sharpeRatio: toNullableDecimalString(sharpeRatio, 2),
      bestDay: bestWorst.bestDay
        ? {
            period: bestWorst.bestDay.period,
            percent: toDecimalString(bestWorst.bestDay.percent, 2),
          }
        : null,
      worstDay: bestWorst.worstDay
        ? {
            period: bestWorst.worstDay.period,
            percent: toDecimalString(bestWorst.worstDay.percent, 2),
          }
        : null,
      bestMonth: bestWorst.bestMonth
        ? {
            period: bestWorst.bestMonth.period,
            percent: toDecimalString(bestWorst.bestMonth.percent, 2),
          }
        : null,
      worstMonth: bestWorst.worstMonth
        ? {
            period: bestWorst.worstMonth.period,
            percent: toDecimalString(bestWorst.worstMonth.percent, 2),
          }
        : null,
      closedTradeCount,
      winningTradeCount,
      winRatePercent: toNullableDecimalString(winRate, 1),
      drawdown: {
        points: drawdownResult.points.map((pt) => ({
          date: pt.date,
          drawdownPercent: toDecimalString(pt.drawdownPercent, 2),
        })),
        maxDrawdownPercent: toNullableDecimalString(
          drawdownResult.maxDrawdownPercent,
          2,
        ),
        peakDate: drawdownResult.peakDate,
        troughDate: drawdownResult.troughDate,
        recoveryDate: drawdownResult.recoveryDate,
        currentDrawdownPercent: toNullableDecimalString(
          drawdownResult.currentDrawdownPercent,
          2,
        ),
      },
    },
    allocations,
    movers: {
      topGainersToday,
      topLosersToday,
      topGainersAllTime,
      topLosersAllTime,
    },
    dividends: {
      totalDividendsInBase: summary.totalDividendsInBase,
      trailing12MonthsInBase: toDecimalString(
        ttmDividends.toDecimalPlaces(2),
        2,
      ),
      projectedAnnualIncomeInBase:
        holdingsWithYieldCount > 0
          ? toDecimalString(projectedAnnualIncome.toDecimalPlaces(2), 2)
          : null,
      holdingsWithYieldCount,
      openHoldingsCount: pricedOpenHoldings.length,
    },
    dataQuality,
    benchmarks,
    requestedBenchmarks,
  };
}
