/**
 * Batch Quote Resolver (`lib/market-data/batch-quotes.ts`).
 *
 * Resolves quotes for any collection of symbols (`AAPL`, `ES3.SI`, `^GSPC`,
 * `UST-USD`, etc.) in bounded parallel batches, combining:
 *  - Instrument-level overrides (`isDelisted`, `manualPrice`)
 *  - Strict no-crypto-fetching rule (`assetType === "crypto"` -> `"unavailable"`
 *    unless a manual price or delisted/worthless flag is set)
 *  - Live / delayed / last-close quotes via `fetchStockPrice` (`ProviderChain`)
 *  - Exact `Decimal.js` day change (`price - previousClose`) and % change
 *  - Automatic write-through of latest daily closes into `price_bar`
 *  - Explicit `"stale_cache"` fallback from `price_bar` when offline (never
 *    silently inventing or disguising stale prices — Master Prompt Rule 5)
 */
import { desc, eq, inArray } from "drizzle-orm";
import { type Database, getDb } from "@/db/client";
import { instrument, type Instrument, priceBar } from "@/db/schema";
import { toDecimal, toDecimalString, ZERO } from "@/lib/finance/decimal";
import { MarketDataError } from "@/lib/market-data/errors";
import { getSingaporeDateString } from "@/lib/market-data/hours";
import {
  ensureInstrumentDailyBars,
  upsertDailyPriceBars,
} from "@/lib/market-data/history";
import { type ProviderChain } from "@/lib/market-data/provider-chain";
import {
  fetchStockPrice,
  formatShortMarketDate,
  getCachedStockPrice,
  type PriceMarketStatus,
} from "@/lib/market-data/quotes";
import { inferInstrumentMetadata } from "@/lib/symbols";

export type ResolvedQuoteStatus =
  | PriceMarketStatus
  | "manual"
  | "delisted"
  | "stale_cache"
  | "unavailable";

export interface ResolvedInstrumentQuote {
  symbol: string;
  name: string | null;
  currency: string;
  exchangeCode: string | null;
  assetType: string;
  /** Exact decimal string, or `null` when `"unavailable"`. */
  price: string | null;
  previousClose: string | null;
  /** Exact 1-day price change (`price - previousClose`), or `null`. */
  dayChange: string | null;
  /** Exact 1-day percentage change (`dayChange / previousClose * 100`), or `null`. */
  dayChangePercent: string | null;
  status: ResolvedQuoteStatus;
  freshnessLabel: string;
  unavailableReason?: string;
  /** True when external market-data providers reported no listing (`not_found`). */
  priceNotFound?: boolean;
  asOf: string | null;
  effectiveDate: string | null;
  source: string | null;
  /** Optional recent daily closes (`price_bar`) for sparklines. */
  sparklineCloses?: string[];
}

export interface ResolveBatchQuotesOptions {
  symbols: readonly string[];
  db?: Database;
  now?: Date;
  fetchImpl?: typeof fetch;
  chain?: ProviderChain;
  skipCache?: boolean;
  /** Re-check symbols previously marked as `priceNotFoundAt` in DB. */
  retryNotFound?: boolean;
  /** Resolve from shared memory/DB caches only without external provider HTTP calls. */
  cacheOnly?: boolean;
  includeSparklines?: boolean;
  concurrency?: number;
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function consume(): Promise<void> {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await worker(items[current]);
    }
  }

  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => consume()));
  return results;
}

function subtractCalendarDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const utc = Date.UTC(y, m - 1, d) - days * 86_400_000;
  return new Date(utc).toISOString().slice(0, 10);
}

function buildSparklineCloses(params: {
  barsAsc: readonly { date: string; close: string }[];
  latestDate: string;
  latestPrice: string;
  fallbackPrevClose: string | null;
}): string[] {
  const normalizedBars = params.barsAsc.filter(
    (b) => b.date < params.latestDate,
  );
  const closes = normalizedBars
    .slice(-19)
    .map((b) => toDecimalString(toDecimal(b.close), 6));

  if (closes.length === 0 && params.fallbackPrevClose) {
    return [
      toDecimalString(toDecimal(params.fallbackPrevClose), 6),
      params.latestPrice,
    ];
  }

  return [...closes, params.latestPrice];
}

function computeDayChanges(
  priceStr: string | null,
  prevCloseStr: string | null,
): { dayChange: string | null; dayChangePercent: string | null } {
  if (!priceStr || !prevCloseStr) {
    return { dayChange: null, dayChangePercent: null };
  }
  const priceDec = toDecimal(priceStr);
  const prevDec = toDecimal(prevCloseStr);
  if (prevDec.lte(ZERO)) {
    return { dayChange: null, dayChangePercent: null };
  }

  const diff = priceDec.minus(prevDec);
  const pct = diff.div(prevDec).mul(100);
  return {
    dayChange: toDecimalString(diff, 6),
    dayChangePercent: toDecimalString(pct, 4),
  };
}

export async function resolveQuotesForSymbols(
  options: ResolveBatchQuotesOptions,
): Promise<Record<string, ResolvedInstrumentQuote>> {
  const uniqueSymbols = [
    ...new Set(options.symbols.map((s) => s.trim()).filter(Boolean)),
  ];

  if (uniqueSymbols.length === 0) {
    return {};
  }

  const database = options.db ?? (await getDb());
  const now = options.now ?? new Date();
  const referenceYear = Number(getSingaporeDateString(now).slice(0, 4));

  // Load matching DB instruments and their recent `price_bar` rows in 2 queries
  const dbInstruments = await database
    .select()
    .from(instrument)
    .where(inArray(instrument.symbol, uniqueSymbols));

  const instrumentBySymbol = new Map<string, Instrument>();
  const instrumentIds: string[] = [];
  for (const row of dbInstruments) {
    instrumentBySymbol.set(row.symbol, row);
    instrumentIds.push(row.id);
  }

  const recentBarsByInstrumentId = new Map<
    string,
    { date: string; close: string; source: string }[]
  >();

  if (instrumentIds.length > 0) {
    const barRows = await database
      .select({
        instrumentId: priceBar.instrumentId,
        date: priceBar.date,
        close: priceBar.close,
        source: priceBar.source,
      })
      .from(priceBar)
      .where(inArray(priceBar.instrumentId, instrumentIds))
      .orderBy(desc(priceBar.date));

    for (const bar of barRows) {
      const list = recentBarsByInstrumentId.get(bar.instrumentId) ?? [];
      if (list.length < 25) {
        list.push({ date: bar.date, close: bar.close, source: bar.source });
        recentBarsByInstrumentId.set(bar.instrumentId, list);
      }
    }
  }

  const concurrency = options.concurrency ?? 10;
  const barsToPersist: {
    instrumentId: string;
    date: string;
    close: string;
    source: string;
  }[] = [];
  const notFoundToPersist: { instrumentId: string; reason: string }[] = [];
  const notFoundToClearIds: string[] = [];

  const resolvedList = await runWithConcurrency(
    uniqueSymbols,
    concurrency,
    async (symbol): Promise<ResolvedInstrumentQuote> => {
      const dbInstr = instrumentBySymbol.get(symbol);
      const inferred = inferInstrumentMetadata({
        symbol,
        name: dbInstr?.name,
        exchangeCode: dbInstr?.exchangeCode,
        currency: dbInstr?.currency,
        assetType: dbInstr?.assetType,
      });

      const recentDesc = dbInstr
        ? (recentBarsByInstrumentId.get(dbInstr.id) ?? [])
        : [];
      const sparklineCloses = options.includeSparklines
        ? [...recentDesc]
            .slice(0, 20)
            .reverse()
            .map((b) => toDecimalString(toDecimal(b.close), 6))
        : undefined;

      // 1. Delisted / worthless override
      if (dbInstr?.isDelisted) {
        const overridePrice = dbInstr.manualPrice
          ? toDecimalString(toDecimal(dbInstr.manualPrice), 6)
          : "0";
        return {
          symbol,
          name: dbInstr.name,
          currency: dbInstr.currency,
          exchangeCode: dbInstr.exchangeCode,
          assetType: dbInstr.assetType,
          price: overridePrice,
          previousClose: null,
          dayChange: null,
          dayChangePercent: null,
          status: "delisted",
          freshnessLabel:
            overridePrice === "0" ? "Marked worthless ($0)" : "Marked delisted",
          asOf: null,
          effectiveDate: null,
          source: "manual",
          sparklineCloses,
        };
      }

      // 2. Explicit manual price override
      if (dbInstr?.manualPrice !== null && dbInstr?.manualPrice !== undefined) {
        const manualStr = toDecimalString(toDecimal(dbInstr.manualPrice), 6);
        return {
          symbol,
          name: dbInstr.name,
          currency: dbInstr.currency,
          exchangeCode: dbInstr.exchangeCode,
          assetType: dbInstr.assetType,
          price: manualStr,
          previousClose: null,
          dayChange: null,
          dayChangePercent: null,
          status: "manual",
          freshnessLabel: "Manual price",
          asOf: null,
          effectiveDate: null,
          source: "manual",
          sparklineCloses,
        };
      }

      // 3. Crypto without manual override -> never fetch external crypto prices
      if (inferred.assetType === "crypto") {
        return {
          symbol,
          name: dbInstr?.name ?? null,
          currency: inferred.currency,
          exchangeCode: inferred.exchangeCode,
          assetType: "crypto",
          price: null,
          previousClose: null,
          dayChange: null,
          dayChangePercent: null,
          status: "unavailable",
          freshnessLabel: "Price unavailable",
          unavailableReason:
            "Crypto price fetching is disabled. Enter a manual price or mark as worthless.",
          asOf: null,
          effectiveDate: null,
          source: null,
          sparklineCloses,
        };
      }

      // 3.5. Persistently known not-found symbols (unless explicit Retry / skipCache)
      const hasPersistedNotFound =
        dbInstr?.priceNotFoundAt !== null && dbInstr?.priceNotFoundAt !== undefined;
      if (hasPersistedNotFound && !options.skipCache && !options.retryNotFound) {
        const latestCached = recentDesc[0];
        if (latestCached) {
          const cachedPrice = toDecimalString(toDecimal(latestCached.close), 6);
          const priorCached = recentDesc[1]
            ? toDecimalString(toDecimal(recentDesc[1].close), 6)
            : null;
          const changes = computeDayChanges(cachedPrice, priorCached);
          return {
            symbol,
            name: dbInstr?.name ?? null,
            currency: inferred.currency,
            exchangeCode: inferred.exchangeCode,
            assetType: inferred.assetType,
            price: cachedPrice,
            previousClose: priorCached,
            dayChange: changes.dayChange,
            dayChangePercent: changes.dayChangePercent,
            status: "stale_cache",
            priceNotFound: true,
            freshnessLabel: `Cached close, ${formatShortMarketDate(
              latestCached.date,
              referenceYear,
            )}`,
            unavailableReason:
              dbInstr?.priceNotFoundReason ??
              `Ticker ${symbol} was not found on market providers.`,
            asOf: `${latestCached.date}T16:00:00.000Z`,
            effectiveDate: latestCached.date,
            source: latestCached.source,
            sparklineCloses,
          };
        }

        return {
          symbol,
          name: dbInstr?.name ?? null,
          currency: inferred.currency,
          exchangeCode: inferred.exchangeCode,
          assetType: inferred.assetType,
          price: null,
          previousClose: null,
          dayChange: null,
          dayChangePercent: null,
          status: "unavailable",
          priceNotFound: true,
          freshnessLabel: "Price not found",
          unavailableReason:
            dbInstr?.priceNotFoundReason ??
            `No market price found for ${symbol}. Automatic lookups are paused.`,
          asOf: null,
          effectiveDate: null,
          source: null,
          sparklineCloses,
        };
      }

      // 4. Live / Cached / Last-close provider lookup (+ auto-seed 1M sparkline history)
      const cachedMemQuote =
        options.skipCache || options.retryNotFound
          ? undefined
          : getCachedStockPrice(symbol);

      if (options.cacheOnly && !cachedMemQuote) {
        if (recentDesc.length > 0) {
          const latestCached = recentDesc[0];
          const cachedPrice = toDecimalString(toDecimal(latestCached.close), 6);
          const priorCached = recentDesc[1]
            ? toDecimalString(toDecimal(recentDesc[1].close), 6)
            : null;
          const changes = computeDayChanges(cachedPrice, priorCached);
          return {
            symbol,
            name: dbInstr?.name ?? null,
            currency: inferred.currency,
            exchangeCode: inferred.exchangeCode,
            assetType: inferred.assetType,
            price: cachedPrice,
            previousClose: priorCached,
            dayChange: changes.dayChange,
            dayChangePercent: changes.dayChangePercent,
            status: "last_close",
            freshnessLabel: `Cached close, ${formatShortMarketDate(
              latestCached.date,
              referenceYear,
            )}`,
            asOf: `${latestCached.date}T16:00:00.000Z`,
            effectiveDate: latestCached.date,
            source: latestCached.source,
            sparklineCloses,
          };
        }

        return {
          symbol,
          name: dbInstr?.name ?? null,
          currency: inferred.currency,
          exchangeCode: inferred.exchangeCode,
          assetType: inferred.assetType,
          price: null,
          previousClose: null,
          dayChange: null,
          dayChangePercent: null,
          status: "unavailable",
          priceNotFound: hasPersistedNotFound || undefined,
          freshnessLabel: hasPersistedNotFound
            ? "Price not found"
            : "Price unavailable",
          unavailableReason: `No cached price stored for ${symbol}.`,
          asOf: null,
          effectiveDate: null,
          source: null,
          sparklineCloses,
        };
      }

      const shouldSeedSparklineBars =
        !options.cacheOnly &&
        options.includeSparklines === true &&
        recentDesc.length < 5;
      const todayIso = getSingaporeDateString(now);

      try {
        const [quote, seededHistory] = await Promise.all([
          cachedMemQuote
            ? Promise.resolve(cachedMemQuote)
            : fetchStockPrice(symbol, {
                now,
                fetchImpl: options.fetchImpl,
                chain: options.chain,
                skipCache: options.skipCache || options.retryNotFound,
              }),
          shouldSeedSparklineBars
            ? ensureInstrumentDailyBars({
                symbol,
                startDate: subtractCalendarDays(todayIso, 35),
                endDate: todayIso,
                forceRefresh: options.retryNotFound,
                db: database,
                now,
                fetchImpl: options.fetchImpl,
                chain: options.chain,
              }).catch(() => null)
            : Promise.resolve(null),
        ]);

        if (dbInstr && hasPersistedNotFound) {
          notFoundToClearIds.push(dbInstr.id);
        }

        const effectiveHistoryAsc =
          seededHistory && seededHistory.bars.length > 0
            ? seededHistory.bars.map((bar) => ({
                date: bar.date,
                close: bar.close,
              }))
            : [...recentDesc].reverse().map((bar) => ({
                date: bar.date,
                close: bar.close,
              }));

        const barsBeforeQuote = effectiveHistoryAsc.filter(
          (bar) => bar.date < quote.effectiveDate,
        );
        const latestPriorBar =
          barsBeforeQuote.length > 0
            ? barsBeforeQuote[barsBeforeQuote.length - 1]
            : null;

        // Fall back to prior daily bar close if provider omitted `previousClose`
        const fallbackPrevClose =
          quote.previousClose ??
          (latestPriorBar
            ? toDecimalString(toDecimal(latestPriorBar.close), 6)
            : null);

        const changes = computeDayChanges(quote.price, fallbackPrevClose);

        if (
          dbInstr &&
          !seededHistory &&
          /^\d{4}-\d{2}-\d{2}$/.test(quote.effectiveDate)
        ) {
          barsToPersist.push({
            instrumentId: dbInstr.id,
            date: quote.effectiveDate,
            close: quote.price,
            source: quote.source,
          });
        }

        const updatedSparkline = options.includeSparklines
          ? buildSparklineCloses({
              barsAsc: effectiveHistoryAsc,
              latestDate: quote.effectiveDate,
              latestPrice: quote.price,
              fallbackPrevClose,
            })
          : undefined;

        return {
          symbol,
          name: dbInstr?.name ?? null,
          currency: quote.currency,
          exchangeCode: dbInstr?.exchangeCode ?? quote.exchangeCode,
          assetType: inferred.assetType,
          price: quote.price,
          previousClose: fallbackPrevClose,
          dayChange: changes.dayChange,
          dayChangePercent: changes.dayChangePercent,
          status: quote.priceStatus,
          freshnessLabel: quote.freshnessLabel,
          asOf: quote.asOf,
          effectiveDate: quote.effectiveDate,
          source: quote.source,
          sparklineCloses: updatedSparkline,
        };
      } catch (error) {
        const isNotFound =
          error instanceof MarketDataError && error.kind === "not_found";
        if (dbInstr && isNotFound) {
          notFoundToPersist.push({
            instrumentId: dbInstr.id,
            reason: error.message,
          });
        }

        // 5. Honest stale-cache fallback if we have a real stored `price_bar`
        const latestCached = recentDesc[0];
        if (latestCached) {
          const cachedPrice = toDecimalString(toDecimal(latestCached.close), 6);
          const priorCached = recentDesc[1]
            ? toDecimalString(toDecimal(recentDesc[1].close), 6)
            : null;
          const changes = computeDayChanges(cachedPrice, priorCached);

          return {
            symbol,
            name: dbInstr?.name ?? null,
            currency: inferred.currency,
            exchangeCode: inferred.exchangeCode,
            assetType: inferred.assetType,
            price: cachedPrice,
            previousClose: priorCached,
            dayChange: changes.dayChange,
            dayChangePercent: changes.dayChangePercent,
            status: "stale_cache",
            priceNotFound: isNotFound || undefined,
            freshnessLabel: `Cached close, ${formatShortMarketDate(
              latestCached.date,
              referenceYear,
            )} (offline)`,
            asOf: `${latestCached.date}T16:00:00.000Z`,
            effectiveDate: latestCached.date,
            source: latestCached.source,
            sparklineCloses,
          };
        }

        return {
          symbol,
          name: dbInstr?.name ?? null,
          currency: inferred.currency,
          exchangeCode: inferred.exchangeCode,
          assetType: inferred.assetType,
          price: null,
          previousClose: null,
          dayChange: null,
          dayChangePercent: null,
          status: "unavailable",
          priceNotFound: isNotFound || undefined,
          freshnessLabel: isNotFound ? "Price not found" : "Price unavailable",
          unavailableReason:
            error instanceof Error
              ? error.message
              : `Price unavailable for ${symbol}.`,
          asOf: null,
          effectiveDate: null,
          source: null,
          sparklineCloses,
        };
      }
    },
  );

  // Best-effort write-through of latest daily closes into `price_bar`
  for (const item of barsToPersist) {
    try {
      await upsertDailyPriceBars(
        item.instrumentId,
        [
          {
            date: item.date,
            open: null,
            high: null,
            low: null,
            close: item.close,
            volume: null,
            source: item.source,
          },
        ],
        database,
      );
    } catch {
      // Non-fatal: never fail a quote response due to cache persistence
    }
  }

  // Persist or clear `price_not_found_at` flags cleanly so unknown tickers do
  // not repeatedly stall future page loads or polls.
  for (const item of notFoundToPersist) {
    try {
      await database
        .update(instrument)
        .set({
          priceNotFoundAt: now,
          priceNotFoundReason: item.reason,
        })
        .where(eq(instrument.id, item.instrumentId));
    } catch {
      // Non-fatal
    }
  }

  if (notFoundToClearIds.length > 0) {
    try {
      await database
        .update(instrument)
        .set({
          priceNotFoundAt: null,
          priceNotFoundReason: null,
        })
        .where(inArray(instrument.id, notFoundToClearIds));
    } catch {
      // Non-fatal
    }
  }

  const record: Record<string, ResolvedInstrumentQuote> = {};
  for (const quote of resolvedList) {
    record[quote.symbol] = quote;
  }
  return record;
}

