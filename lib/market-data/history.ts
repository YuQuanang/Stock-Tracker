/**
 * Historical Price Series & Persistent `price_bar` Cache (`lib/market-data/history.ts`).
 *
 * Responsibilities:
 *  1. Fetches and caches **unadjusted** daily OHLCV bars in the PostgreSQL
 *     `price_bar` table (`(instrument_id, date)`) so portfolio valuation,
 *     benchmark comparison, 52-week ranges, and multi-year stock charts load
 *     instantly from the database without re-fetching years of history.
 *  2. Supports TradingView Lightweight Charts range selectors:
 *       `1D`, `5D` (intraday 5m / 15m bars, cached in memory),
 *       `1M`, `6M`, `YTD`, `1Y`, `5Y`, `MAX` (daily bars, persisted in `price_bar`).
 *  3. Respects the no-crypto-fetching rule: crypto instruments immediately
 *     return `{ status: "unavailable", bars: [] }` with zero external calls.
 */
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { type Database, getDb } from "@/db/client";
import { instrument, priceBar } from "@/db/schema";
import { toDecimal, toDecimalString } from "@/lib/finance/decimal";
import { TtlCache } from "@/lib/market-data/cache";
import {
  BROWSER_USER_AGENT,
  fetchProviderJson,
  MarketDataError,
} from "@/lib/market-data/errors";
import {
  getMarketSessionStatus,
  getSingaporeDateString,
  inferMarketRegion,
} from "@/lib/market-data/hours";
import {
  globalProviderChain,
  type ProviderChain,
  type ProviderStep,
} from "@/lib/market-data/provider-chain";
import { toStooqSymbol } from "@/lib/market-data/quotes";
import { inferInstrumentMetadata } from "@/lib/symbols";

export type ChartRange =
  | "1D"
  | "5D"
  | "1M"
  | "6M"
  | "YTD"
  | "1Y"
  | "5Y"
  | "MAX";

export interface HistoricalPricePoint {
  /**
   * For daily bars: `YYYY-MM-DD` exchange date string.
   * For intraday bars (`1D`, `5D`): Unix seconds UTC (`number`).
   */
  time: string | number;
  date: string;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string;
  volume: string | null;
}

export interface PriceHistoryResult {
  symbol: string;
  currency: string;
  range: ChartRange;
  interval: "5m" | "15m" | "1d";
  status: "ok" | "stale_cache" | "unavailable";
  unavailableReason?: string;
  source: string | null;
  bars: HistoricalPricePoint[];
}

interface DailyBarRecord {
  date: string;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string;
  volume: string | null;
  source: string;
}

interface YahooHistoryChartResponse {
  chart?: {
    result?: {
      meta?: {
        symbol?: string;
        currency?: string;
        exchangeTimezoneName?: string;
      };
      timestamp?: number[];
      indicators?: {
        quote?: {
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }[];
      };
    }[];
  };
}

const intradayCache = new TtlCache<PriceHistoryResult>(120);
/** Tracks when a daily `price_bar` sync last succeeded for `instrumentId|startDate`. */
const dailySyncFreshness = new TtlCache<boolean>(300);
const DAILY_SYNC_TTL_OPEN_MS = 5 * 60 * 1000; // 5 minutes during session
const DAILY_SYNC_TTL_CLOSED_MS = 60 * 60 * 1000; // 1 hour when closed

function addCalendarDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const year = dt.getUTCFullYear();
  const month = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(dt.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toIsoDateInTimezone(unixSeconds: number, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date(unixSeconds * 1000));
}

function cleanOptionalPriceNumber(raw: number | null | undefined): string | null {
  if (raw === null || raw === undefined || !Number.isFinite(raw) || raw < 0) {
    return null;
  }
  return toDecimalString(toDecimal(raw).toDecimalPlaces(6), 6);
}

function cleanOptionalVolumeNumber(raw: number | null | undefined): string | null {
  if (raw === null || raw === undefined || !Number.isFinite(raw) || raw < 0) {
    return null;
  }
  return toDecimalString(toDecimal(Math.round(raw)), 0);
}

function mapDbPriceBarToPoint(row: {
  date: string;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string;
  volume: string | null;
}): HistoricalPricePoint {
  return {
    time: row.date,
    date: row.date,
    open: row.open ? toDecimalString(toDecimal(row.open), 6) : null,
    high: row.high ? toDecimalString(toDecimal(row.high), 6) : null,
    low: row.low ? toDecimalString(toDecimal(row.low), 6) : null,
    close: toDecimalString(toDecimal(row.close), 6),
    volume: row.volume ? toDecimalString(toDecimal(row.volume), 0) : null,
  };
}

/** Computes the inclusive `startDate` (`YYYY-MM-DD`) for a daily `ChartRange`. */
export function resolveStartDateForRange(
  range: Exclude<ChartRange, "1D" | "5D">,
  todayIso: string,
): string {
  switch (range) {
    case "1M":
      return addCalendarDays(todayIso, -32);
    case "6M":
      return addCalendarDays(todayIso, -185);
    case "YTD":
      return `${todayIso.slice(0, 4)}-01-01`;
    case "1Y":
      return addCalendarDays(todayIso, -366);
    case "5Y":
      return addCalendarDays(todayIso, -365 * 5 - 2);
    case "MAX":
      return "2005-01-01";
  }
}

async function fetchYahooDailyBars(params: {
  symbol: string;
  startDate: string;
  endDate: string;
  fetchImpl?: typeof fetch;
}): Promise<{ currency: string; bars: DailyBarRecord[] }> {
  const [sy, sm, sd] = params.startDate.split("-").map(Number);
  const [ey, em, ed] = params.endDate.split("-").map(Number);
  const period1 = Math.floor(Date.UTC(sy, sm - 1, sd, 0, 0, 0) / 1000) - 86400;
  const period2 =
    Math.floor(Date.UTC(ey, em - 1, ed, 23, 59, 59) / 1000) + 86400;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    params.symbol,
  )}?interval=1d&period1=${period1}&period2=${period2}`;

  const payload = await fetchProviderJson<YahooHistoryChartResponse>({
    provider: "Yahoo Finance",
    url,
    timeoutMs: 10_000,
    fetchImpl: params.fetchImpl,
  });

  const result = payload.chart?.result?.[0];
  const meta = result?.meta;
  const timestamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];

  if (!meta || !quote || timestamps.length === 0) {
    throw new MarketDataError(
      "not_found",
      "Yahoo Finance",
      `No daily history returned for "${params.symbol}".`,
    );
  }

  const region = inferMarketRegion(meta.symbol ?? params.symbol);
  const exchangeTz =
    meta.exchangeTimezoneName ??
    (region === "SG" ? "Asia/Singapore" : "America/New_York");
  const currency =
    (meta.currency ?? "").toUpperCase() || (region === "SG" ? "SGD" : "USD");

  // Deduplicate by calendar date in exchange timezone (keeping latest bar per day).
  const byDate = new Map<string, DailyBarRecord>();

  for (let i = 0; i < timestamps.length; i += 1) {
    const rawClose = quote.close?.[i];
    if (
      rawClose === null ||
      rawClose === undefined ||
      !Number.isFinite(rawClose) ||
      rawClose < 0
    ) {
      continue;
    }

    const barDate = toIsoDateInTimezone(timestamps[i], exchangeTz);
    if (barDate < params.startDate || barDate > params.endDate) {
      continue;
    }

    byDate.set(barDate, {
      date: barDate,
      open: cleanOptionalPriceNumber(quote.open?.[i]),
      high: cleanOptionalPriceNumber(quote.high?.[i]),
      low: cleanOptionalPriceNumber(quote.low?.[i]),
      close: toDecimalString(toDecimal(rawClose).toDecimalPlaces(6), 6),
      volume: cleanOptionalVolumeNumber(quote.volume?.[i]),
      source: "yahoo",
    });
  }

  const bars = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (bars.length === 0) {
    throw new MarketDataError(
      "not_found",
      "Yahoo Finance",
      `No valid daily bars in range for "${params.symbol}".`,
    );
  }

  return { currency, bars };
}

async function fetchStooqDailyBars(params: {
  symbol: string;
  startDate: string;
  endDate: string;
  fetchImpl?: typeof fetch;
}): Promise<{ currency: string; bars: DailyBarRecord[] }> {
  const stooqTicker = toStooqSymbol(params.symbol);
  const d1 = params.startDate.replaceAll("-", "");
  const d2 = params.endDate.replaceAll("-", "");
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(
    stooqTicker,
  )}&d1=${d1}&d2=${d2}&i=d`;

  const fetchFn = params.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: { "User-Agent": BROWSER_USER_AGENT },
      cache: "no-store",
    });
  } catch {
    throw new MarketDataError(
      "network",
      "Stooq",
      `Could not reach Stooq history for "${params.symbol}".`,
    );
  }

  if (!response.ok) {
    throw new MarketDataError(
      "upstream",
      "Stooq",
      `Stooq returned status ${response.status}.`,
    );
  }

  const text = await response.text();
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("Date,"));

  if (lines.length === 0 || text.includes("No data")) {
    throw new MarketDataError(
      "not_found",
      "Stooq",
      `No Stooq daily bars available for "${params.symbol}".`,
    );
  }

  const bars: DailyBarRecord[] = [];
  for (const line of lines) {
    const [date, open, high, low, close, volume] = line.split(",");
    if (!date || !close || date < params.startDate || date > params.endDate) {
      continue;
    }
    const closeNum = Number(close);
    if (!Number.isFinite(closeNum) || closeNum < 0) {
      continue;
    }

    bars.push({
      date,
      open: open ? cleanOptionalPriceNumber(Number(open)) : null,
      high: high ? cleanOptionalPriceNumber(Number(high)) : null,
      low: low ? cleanOptionalPriceNumber(Number(low)) : null,
      close: toDecimalString(toDecimal(close), 6),
      volume: volume ? cleanOptionalVolumeNumber(Number(volume)) : null,
      source: "stooq",
    });
  }

  bars.sort((a, b) => a.date.localeCompare(b.date));
  if (bars.length === 0) {
    throw new MarketDataError(
      "not_found",
      "Stooq",
      `No Stooq bars in range for "${params.symbol}".`,
    );
  }

  const upper = params.symbol.trim().toUpperCase();
  const currency = upper.endsWith(".SI") || upper === "^STI" ? "SGD" : "USD";
  return { currency, bars };
}

async function fetchYahooIntradaySeries(params: {
  symbol: string;
  range: "1D" | "5D";
  now: Date;
  fetchImpl?: typeof fetch;
}): Promise<PriceHistoryResult> {
  const interval = params.range === "1D" ? "5m" : "15m";
  const yahooRange = params.range === "1D" ? "1d" : "5d";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    params.symbol,
  )}?interval=${interval}&range=${yahooRange}`;

  const payload = await fetchProviderJson<YahooHistoryChartResponse>({
    provider: "Yahoo Finance",
    url,
    fetchImpl: params.fetchImpl,
  });

  const result = payload.chart?.result?.[0];
  const meta = result?.meta;
  const timestamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];

  if (!meta || !quote || timestamps.length === 0) {
    throw new MarketDataError(
      "not_found",
      "Yahoo Finance",
      `No intraday bars returned for "${params.symbol}".`,
    );
  }

  const region = inferMarketRegion(meta.symbol ?? params.symbol);
  const exchangeTz =
    meta.exchangeTimezoneName ??
    (region === "SG" ? "Asia/Singapore" : "America/New_York");
  const currency =
    (meta.currency ?? "").toUpperCase() || (region === "SG" ? "SGD" : "USD");

  const bars: HistoricalPricePoint[] = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const rawClose = quote.close?.[i];
    if (
      rawClose === null ||
      rawClose === undefined ||
      !Number.isFinite(rawClose)
    ) {
      continue;
    }

    bars.push({
      time: timestamps[i],
      date: toIsoDateInTimezone(timestamps[i], exchangeTz),
      open: cleanOptionalPriceNumber(quote.open?.[i]),
      high: cleanOptionalPriceNumber(quote.high?.[i]),
      low: cleanOptionalPriceNumber(quote.low?.[i]),
      close: toDecimalString(toDecimal(rawClose).toDecimalPlaces(6), 6),
      volume: cleanOptionalVolumeNumber(quote.volume?.[i]),
    });
  }

  return {
    symbol: meta.symbol ?? params.symbol,
    currency,
    range: params.range,
    interval,
    status: "ok",
    source: "yahoo",
    bars,
  };
}

/**
 * Persists daily bars into `price_bar`, updating OHLCV on `(instrumentId, date)`
 * conflict so intraday partial bars get replaced by final settlement closes.
 */
export async function upsertDailyPriceBars(
  instrumentId: string,
  bars: readonly DailyBarRecord[],
  database: Database,
): Promise<void> {
  if (bars.length === 0) {
    return;
  }

  const BATCH_SIZE = 200;
  for (let offset = 0; offset < bars.length; offset += BATCH_SIZE) {
    const chunk = bars.slice(offset, offset + BATCH_SIZE);
    await database
      .insert(priceBar)
      .values(
        chunk.map((bar) => ({
          instrumentId,
          date: bar.date,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
          source: bar.source,
        })),
      )
      .onConflictDoUpdate({
        target: [priceBar.instrumentId, priceBar.date],
        set: {
          open: sql`excluded.open`,
          high: sql`excluded.high`,
          low: sql`excluded.low`,
          close: sql`excluded.close`,
          volume: sql`excluded.volume`,
          source: sql`excluded.source`,
        },
      });
  }
}

export interface EnsureDailyBarsOptions {
  symbol: string;
  startDate: string;
  endDate?: string;
  db?: Database;
  now?: Date;
  fetchImpl?: typeof fetch;
  chain?: ProviderChain;
  forceRefresh?: boolean;
}

/**
 * Ensures the `price_bar` table has daily bars for `symbol` across
 * `[startDate, endDate]`, creating the `instrument` row (for benchmarks such as
 * `^GSPC` or `^STI`) if not yet present.
 */
export async function ensureInstrumentDailyBars(
  options: EnsureDailyBarsOptions,
): Promise<{
  instrumentId: string | null;
  currency: string;
  status: "ok" | "stale_cache" | "unavailable";
  unavailableReason?: string;
  source: string | null;
  bars: HistoricalPricePoint[];
}> {
  const cleanSymbol = options.symbol.trim();
  const inferred = inferInstrumentMetadata({ symbol: cleanSymbol });

  if (inferred.assetType === "crypto") {
    return {
      instrumentId: null,
      currency: inferred.currency,
      status: "unavailable",
      unavailableReason:
        "Crypto market-data fetching is disabled. Set a manual price override if needed.",
      source: null,
      bars: [],
    };
  }

  const database = options.db ?? (await getDb());
  const now = options.now ?? new Date();
  const endDate = options.endDate ?? getSingaporeDateString(now);

  // Locate or register the instrument (e.g. benchmark index `^GSPC` or `^STI`)
  let existingRows = await database
    .select()
    .from(instrument)
    .where(eq(instrument.symbol, cleanSymbol))
    .limit(1);

  if (!existingRows[0]) {
    await database
      .insert(instrument)
      .values({
        symbol: inferred.symbol,
        exchangeCode: inferred.exchangeCode,
        currency: inferred.currency,
        assetType: inferred.assetType,
      })
      .onConflictDoNothing();

    existingRows = await database
      .select()
      .from(instrument)
      .where(eq(instrument.symbol, cleanSymbol))
      .limit(1);
  }

  const targetInstrument = existingRows[0];
  if (!targetInstrument) {
    return {
      instrumentId: null,
      currency: inferred.currency,
      status: "unavailable",
      unavailableReason: "Instrument could not be registered.",
      source: null,
      bars: [],
    };
  }

  if (targetInstrument.assetType === "crypto" || targetInstrument.isDelisted) {
    return {
      instrumentId: targetInstrument.id,
      currency: targetInstrument.currency,
      status: "unavailable",
      unavailableReason: targetInstrument.isDelisted
        ? "Instrument is marked delisted."
        : "Crypto market-data fetching is disabled.",
      source: null,
      bars: [],
    };
  }

  const cachedRows = await database
    .select()
    .from(priceBar)
    .where(
      and(
        eq(priceBar.instrumentId, targetInstrument.id),
        gte(priceBar.date, options.startDate),
        lte(priceBar.date, endDate),
      ),
    )
    .orderBy(asc(priceBar.date));

  const region = inferMarketRegion(
    targetInstrument.symbol,
    targetInstrument.exchangeCode,
  );
  const session = getMarketSessionStatus(region, now);
  const syncKey = `${targetInstrument.id}|${options.startDate}|${endDate}`;
  const recentlySynced =
    !options.forceRefresh && dailySyncFreshness.get(syncKey, now.getTime()) === true;

  // Check whether cached DB bars already span from near `startDate` to near `endDate`.
  const earliestCached = cachedRows[0]?.date ?? null;
  const latestCached = cachedRows[cachedRows.length - 1]?.date ?? null;
  const coversStart =
    earliestCached !== null &&
    earliestCached <= addCalendarDays(options.startDate, 7);
  const coversEnd =
    latestCached !== null && latestCached >= addCalendarDays(endDate, -4);

  if (
    !options.forceRefresh &&
    cachedRows.length > 0 &&
    (recentlySynced || (!session.isOpen && coversStart && coversEnd))
  ) {
    return {
      instrumentId: targetInstrument.id,
      currency: targetInstrument.currency,
      status: "ok",
      source: cachedRows[cachedRows.length - 1]?.source ?? "cache",
      bars: cachedRows.map(mapDbPriceBarToPoint),
    };
  }

  // Only fetch the missing window if `coversStart` already holds!
  const fetchStart =
    coversStart && latestCached !== null
      ? addCalendarDays(latestCached, -5)
      : options.startDate;

  const activeChain = options.chain ?? globalProviderChain;
  const steps: ProviderStep<{ currency: string; bars: DailyBarRecord[] }>[] = [
    {
      provider: "yahoo",
      execute: () =>
        fetchYahooDailyBars({
          symbol: cleanSymbol,
          startDate: fetchStart,
          endDate,
          fetchImpl: options.fetchImpl,
        }),
    },
    {
      provider: "stooq",
      execute: () =>
        fetchStooqDailyBars({
          symbol: cleanSymbol,
          startDate: fetchStart,
          endDate,
          fetchImpl: options.fetchImpl,
        }),
    },
  ];

  try {
    const resolved = await activeChain.execute(steps, now.getTime());
    await upsertDailyPriceBars(
      targetInstrument.id,
      resolved.value.bars,
      database,
    );
    dailySyncFreshness.set(
      syncKey,
      true,
      session.isOpen ? DAILY_SYNC_TTL_OPEN_MS : DAILY_SYNC_TTL_CLOSED_MS,
      now.getTime(),
    );

    const refreshedRows = await database
      .select()
      .from(priceBar)
      .where(
        and(
          eq(priceBar.instrumentId, targetInstrument.id),
          gte(priceBar.date, options.startDate),
          lte(priceBar.date, endDate),
        ),
      )
      .orderBy(asc(priceBar.date));

    return {
      instrumentId: targetInstrument.id,
      currency: targetInstrument.currency,
      status: "ok",
      source: resolved.provider,
      bars: refreshedRows.map(mapDbPriceBarToPoint),
    };
  } catch {
    // Master Prompt Rule 5: Never fabricate data; if cached bars exist, return
    // them explicitly labelled `stale_cache`.
    if (cachedRows.length > 0) {
      return {
        instrumentId: targetInstrument.id,
        currency: targetInstrument.currency,
        status: "stale_cache",
        source: cachedRows[cachedRows.length - 1]?.source ?? "cache",
        bars: cachedRows.map(mapDbPriceBarToPoint),
      };
    }

    return {
      instrumentId: targetInstrument.id,
      currency: targetInstrument.currency,
      status: "unavailable",
      unavailableReason: `Historical price data is currently unavailable for ${cleanSymbol}.`,
      source: null,
      bars: [],
    };
  }
}

/**
 * Unified chart history entry point supporting both intraday (`1D`, `5D`) and
 * daily (`1M`, `6M`, `YTD`, `1Y`, `5Y`, `MAX`) ranges.
 */
export async function fetchPriceHistoryForRange(params: {
  symbol: string;
  range: ChartRange;
  db?: Database;
  now?: Date;
  fetchImpl?: typeof fetch;
  chain?: ProviderChain;
}): Promise<PriceHistoryResult> {
  const symbol = params.symbol.trim();
  const now = params.now ?? new Date();
  const inferred = inferInstrumentMetadata({ symbol });

  if (inferred.assetType === "crypto") {
    return {
      symbol,
      currency: inferred.currency,
      range: params.range,
      interval: "1d",
      status: "unavailable",
      unavailableReason: "Crypto price fetching is disabled.",
      source: null,
      bars: [],
    };
  }

  if (params.range === "1D" || params.range === "5D") {
    const region = inferMarketRegion(symbol);
    const session = getMarketSessionStatus(region, now);
    const ttl = session.isOpen ? 60_000 : 15 * 60_000;
    const cacheKey = `${symbol.toUpperCase()}|${params.range}`;

    try {
      return await intradayCache.getOrFetch(cacheKey, ttl, () =>
        fetchYahooIntradaySeries({
          symbol,
          range: params.range as "1D" | "5D",
          now,
          fetchImpl: params.fetchImpl,
        }),
      );
    } catch {
      // Fall back cleanly to recent 1M daily bars if intraday feed is unavailable
      const fallbackStart = addCalendarDays(getSingaporeDateString(now), -14);
      const dailyFallback = await ensureInstrumentDailyBars({
        symbol,
        startDate: fallbackStart,
        db: params.db,
        now,
        fetchImpl: params.fetchImpl,
        chain: params.chain,
      });

      return {
        symbol,
        currency: dailyFallback.currency,
        range: params.range,
        interval: "1d",
        status: dailyFallback.status,
        unavailableReason: dailyFallback.unavailableReason,
        source: dailyFallback.source,
        bars: dailyFallback.bars,
      };
    }
  }

  const todayIso = getSingaporeDateString(now);
  const startDate = resolveStartDateForRange(params.range, todayIso);
  const daily = await ensureInstrumentDailyBars({
    symbol,
    startDate,
    endDate: todayIso,
    db: params.db,
    now,
    fetchImpl: params.fetchImpl,
    chain: params.chain,
  });

  return {
    symbol,
    currency: daily.currency,
    range: params.range,
    interval: "1d",
    status: daily.status,
    unavailableReason: daily.unavailableReason,
    source: daily.source,
    bars: daily.bars,
  };
}

export function clearHistoryCaches(): void {
  intradayCache.clear();
  dailySyncFreshness.clear();
}
