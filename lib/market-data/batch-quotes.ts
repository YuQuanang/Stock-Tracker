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
import { desc, inArray } from "drizzle-orm";
import { type Database, getDb } from "@/db/client";
import { instrument, type Instrument, priceBar } from "@/db/schema";
import { toDecimal, toDecimalString, ZERO } from "@/lib/finance/decimal";
import { getSingaporeDateString } from "@/lib/market-data/hours";
import { upsertDailyPriceBars } from "@/lib/market-data/history";
import { type ProviderChain } from "@/lib/market-data/provider-chain";
import {
  fetchStockPrice,
  formatShortMarketDate,
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

  const concurrency = options.concurrency ?? 6;
  const barsToPersist: {
    instrumentId: string;
    date: string;
    close: string;
    source: string;
  }[] = [];

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

      // 4. Live / Last-close provider lookup
      try {
        const quote = await fetchStockPrice(symbol, {
          now,
          fetchImpl: options.fetchImpl,
          chain: options.chain,
          skipCache: options.skipCache,
        });

        // Fall back to second-newest DB close if provider omitted `previousClose`
        const fallbackPrevClose =
          quote.previousClose ??
          (recentDesc.length >= 2 && recentDesc[0]?.date === quote.effectiveDate
            ? toDecimalString(toDecimal(recentDesc[1].close), 6)
            : recentDesc.length >= 1 && recentDesc[0]?.date < quote.effectiveDate
              ? toDecimalString(toDecimal(recentDesc[0].close), 6)
              : null);

        const changes = computeDayChanges(quote.price, fallbackPrevClose);

        if (dbInstr && /^\d{4}-\d{2}-\d{2}$/.test(quote.effectiveDate)) {
          barsToPersist.push({
            instrumentId: dbInstr.id,
            date: quote.effectiveDate,
            close: quote.price,
            source: quote.source,
          });
        }

        const updatedSparkline =
          sparklineCloses !== undefined
            ? sparklineCloses.length > 0
              ? [...sparklineCloses.slice(0, -1), quote.price]
              : [quote.price]
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
          freshnessLabel: "Price unavailable",
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

  const record: Record<string, ResolvedInstrumentQuote> = {};
  for (const quote of resolvedList) {
    record[quote.symbol] = quote;
  }
  return record;
}

