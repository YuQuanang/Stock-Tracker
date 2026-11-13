/**
 * Server-side foreign-exchange rate fetcher (USD -> SGD, latest + historical).
 *
 * Primary source: Frankfurter API (`api.frankfurter.dev/v1/`, ECB reference rates,
 * free, no API key; automatically resolves weekends/holidays to the prior
 * business day).
 * Fallback source: Yahoo Finance `SGD=X` chart endpoint.
 *
 * All rates are returned as exact decimal strings (never floating-point math).
 */
import { toDecimal, toDecimalString } from "@/lib/finance/decimal";
import { TtlCache } from "@/lib/market-data/cache";
import { fetchProviderJson, MarketDataError } from "@/lib/market-data/errors";
import { getSingaporeDateString } from "@/lib/market-data/hours";
import { formatShortMarketDate } from "@/lib/market-data/quotes";

export interface ExchangeRateSnapshot {
  from: "USD" | "SGD";
  to: "SGD";
  /** Exact decimal multiplier (`amountInSgd = amountInFrom * rate`). */
  rate: string;
  /** Calendar date (`YYYY-MM-DD`) of the published rate. */
  effectiveDate: string;
  /** ISO-8601 UTC timestamp when this rate snapshot was retrieved. */
  asOf: string;
  /** Provider identifier stored permanently with the transaction. */
  source: "native-sgd" | "frankfurter" | "yahoo";
  /** Human-readable label shown beside the FX field. */
  label: string;
  isHistorical: boolean;
}

const LATEST_FX_TTL_MS = 15 * 60 * 1000; // 15 minutes
const HISTORICAL_FX_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const fxCache = new TtlCache<ExchangeRateSnapshot>(300, "fx-latest");

export function getCachedUsdToSgdSnapshot(): ExchangeRateSnapshot | undefined {
  return fxCache.get("USD->SGD|latest");
}

interface FrankfurterResponse {
  amount?: number;
  base?: string;
  date?: string;
  rates?: Record<string, number>;
}

interface FrankfurterTimeSeriesResponse {
  amount?: number;
  base?: string;
  start_date?: string;
  end_date?: string;
  rates?: Record<string, { SGD?: number }>;
}

export interface HistoricalFxDailyBar {
  date: string;
  fromCurrency: "USD";
  toCurrency: "SGD";
  rate: string;
  source: "frankfurter" | "yahoo";
}

interface YahooFxChartResponse {
  chart?: {
    result?: {
      meta?: {
        regularMarketPrice?: number;
        regularMarketTime?: number;
      };
      timestamp?: number[];
      indicators?: {
        quote?: {
          close?: (number | null)[];
        }[];
      };
    }[];
  };
}

async function fetchViaFrankfurter(
  targetDate: string | null,
  now: Date,
  fetchImpl?: typeof fetch,
): Promise<ExchangeRateSnapshot> {
  const pathSegment = targetDate ?? "latest";
  const url = `https://api.frankfurter.dev/v1/${encodeURIComponent(
    pathSegment,
  )}?base=USD&symbols=SGD`;

  const payload = await fetchProviderJson<FrankfurterResponse>({
    provider: "Frankfurter",
    url,
    fetchImpl,
  });

  const rawRate = payload.rates?.SGD;
  const effectiveDate = payload.date;
  if (
    typeof rawRate !== "number" ||
    !Number.isFinite(rawRate) ||
    rawRate <= 0 ||
    !effectiveDate
  ) {
    throw new MarketDataError(
      "upstream",
      "Frankfurter",
      "Exchange rate response was incomplete.",
    );
  }

  const referenceYear = Number(getSingaporeDateString(now).slice(0, 4));
  const isHistorical = targetDate !== null;
  const shortDate = formatShortMarketDate(effectiveDate, referenceYear);

  return {
    from: "USD",
    to: "SGD",
    rate: toDecimalString(toDecimal(rawRate), 6),
    effectiveDate,
    asOf: now.toISOString(),
    source: "frankfurter",
    label: isHistorical ? `ECB rate on ${shortDate}` : `ECB rate, ${shortDate}`,
    isHistorical,
  };
}

async function fetchViaYahooSgdX(
  targetDate: string | null,
  now: Date,
  fetchImpl?: typeof fetch,
): Promise<ExchangeRateSnapshot> {
  const referenceYear = Number(getSingaporeDateString(now).slice(0, 4));

  if (targetDate === null) {
    const url =
      "https://query1.finance.yahoo.com/v8/finance/chart/SGD%3DX?interval=1d&range=5d";
    const payload = await fetchProviderJson<YahooFxChartResponse>({
      provider: "Yahoo Finance",
      url,
      fetchImpl,
    });
    const meta = payload.chart?.result?.[0]?.meta;
    if (
      !meta ||
      typeof meta.regularMarketPrice !== "number" ||
      meta.regularMarketPrice <= 0
    ) {
      throw new MarketDataError(
        "upstream",
        "Yahoo Finance",
        "Fallback USD/SGD rate is unavailable.",
      );
    }
    const unixSec =
      meta.regularMarketTime ?? Math.floor(now.getTime() / 1000);
    const effectiveDate = new Date(unixSec * 1000).toISOString().slice(0, 10);

    return {
      from: "USD",
      to: "SGD",
      rate: toDecimalString(toDecimal(meta.regularMarketPrice).toDecimalPlaces(6), 6),
      effectiveDate,
      asOf: now.toISOString(),
      source: "yahoo",
      label: `Market FX, ${formatShortMarketDate(effectiveDate, referenceYear)}`,
      isHistorical: false,
    };
  }

  const [yearStr, monthStr, dayStr] = targetDate.split("-");
  const period2 =
    Math.floor(
      Date.UTC(Number(yearStr), Number(monthStr) - 1, Number(dayStr), 23, 59, 59) /
        1000,
    ) + 86400;
  const period1 = period2 - 10 * 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/SGD%3DX?interval=1d&period1=${period1}&period2=${period2}`;

  const payload = await fetchProviderJson<YahooFxChartResponse>({
    provider: "Yahoo Finance",
    url,
    fetchImpl,
  });
  const result = payload.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];

  for (let idx = timestamps.length - 1; idx >= 0; idx -= 1) {
    const barClose = closes[idx];
    const barDate = new Date(timestamps[idx] * 1000).toISOString().slice(0, 10);
    if (
      barClose !== null &&
      barClose !== undefined &&
      Number.isFinite(barClose) &&
      barClose > 0 &&
      barDate <= targetDate
    ) {
      const cleaned = toDecimal(barClose).toDecimalPlaces(6);
      return {
        from: "USD",
        to: "SGD",
        rate: toDecimalString(cleaned, 6),
        effectiveDate: barDate,
        asOf: now.toISOString(),
        source: "yahoo",
        label: `Market FX on ${formatShortMarketDate(barDate, referenceYear)}`,
        isHistorical: true,
      };
    }
  }

  throw new MarketDataError(
    "not_found",
    "Yahoo Finance",
    `No USD/SGD rate found on or before ${targetDate}.`,
  );
}

export interface FetchUsdToSgdOptions {
  from?: "USD" | "SGD";
  /** Optional trade date (`YYYY-MM-DD`). Past dates fetch historical FX. */
  date?: string | null;
  now?: Date;
  fetchImpl?: typeof fetch;
  skipCache?: boolean;
}

/**
 * Fetches the `USD -> SGD` exchange rate (or returns `1` immediately when
 * `from === "SGD"`). Never invents a fallback constant on failure.
 */
export async function fetchExchangeRateToSgd(
  options: FetchUsdToSgdOptions = {},
): Promise<ExchangeRateSnapshot> {
  const from = options.from ?? "USD";
  const now = options.now ?? new Date();
  const todaySgt = getSingaporeDateString(now);
  const requestedDate = options.date?.trim() || null;

  if (from === "SGD") {
    return {
      from: "SGD",
      to: "SGD",
      rate: "1",
      effectiveDate: requestedDate ?? todaySgt,
      asOf: now.toISOString(),
      source: "native-sgd",
      label: "Priced in SGD (1:1)",
      isHistorical: false,
    };
  }

  const isBackdated = requestedDate !== null && requestedDate < todaySgt;
  const targetDate = isBackdated ? requestedDate : null;
  const cacheKey = `USD->SGD|${targetDate ?? "latest"}`;
  const ttl = isBackdated ? HISTORICAL_FX_TTL_MS : LATEST_FX_TTL_MS;

  const execute = async (): Promise<ExchangeRateSnapshot> => {
    try {
      return await fetchViaFrankfurter(targetDate, now, options.fetchImpl);
    } catch (primaryError) {
      try {
        return await fetchViaYahooSgdX(targetDate, now, options.fetchImpl);
      } catch {
        throw primaryError;
      }
    }
  };

  return options.skipCache
    ? execute()
    : fxCache.getOrFetch(cacheKey, ttl, execute);
}

export function clearFxCache(): void {
  fxCache.clear();
}

function shiftIsoCalendarDays(isoDate: string, deltaDays: number): string {
  const [yearStr, monthStr, dayStr] = isoDate.split("-");
  const utc = new Date(
    Date.UTC(Number(yearStr), Number(monthStr) - 1, Number(dayStr) + deltaDays),
  );
  const year = utc.getUTCFullYear();
  const month = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const day = String(utc.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function fetchTimeSeriesViaFrankfurter(params: {
  queryStart: string;
  queryEnd: string;
  fetchImpl?: typeof fetch;
}): Promise<HistoricalFxDailyBar[]> {
  const rangeSegment =
    params.queryStart < params.queryEnd
      ? `${params.queryStart}..${params.queryEnd}`
      : params.queryStart;
  const url = `https://api.frankfurter.dev/v1/${encodeURIComponent(
    rangeSegment,
  )}?base=USD&symbols=SGD`;

  const payload = await fetchProviderJson<
    FrankfurterTimeSeriesResponse & FrankfurterResponse
  >({
    provider: "Frankfurter",
    url,
    timeoutMs: 8000,
    fetchImpl: params.fetchImpl,
  });

  const bars: HistoricalFxDailyBar[] = [];

  // Handle single-date shape if Frankfurter collapsed a 1-day range
  if (
    typeof payload.date === "string" &&
    payload.rates &&
    typeof (payload.rates as Record<string, unknown>).SGD === "number"
  ) {
    const rawVal = (payload.rates as Record<string, number>).SGD;
    if (Number.isFinite(rawVal) && rawVal > 0) {
      bars.push({
        date: payload.date,
        fromCurrency: "USD",
        toCurrency: "SGD",
        rate: toDecimalString(toDecimal(rawVal), 6),
        source: "frankfurter",
      });
    }
    return bars;
  }

  const seriesRates = payload.rates as
    | Record<string, { SGD?: number }>
    | undefined;
  if (!seriesRates || typeof seriesRates !== "object") {
    throw new MarketDataError(
      "upstream",
      "Frankfurter",
      "Historical FX time-series response was empty.",
    );
  }

  for (const [date, entry] of Object.entries(seriesRates)) {
    const rawRate = entry?.SGD;
    if (
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      typeof rawRate === "number" &&
      Number.isFinite(rawRate) &&
      rawRate > 0
    ) {
      bars.push({
        date,
        fromCurrency: "USD",
        toCurrency: "SGD",
        rate: toDecimalString(toDecimal(rawRate), 6),
        source: "frankfurter",
      });
    }
  }

  if (bars.length === 0) {
    throw new MarketDataError(
      "not_found",
      "Frankfurter",
      `No USD/SGD historical rates returned for ${params.queryStart}..${params.queryEnd}.`,
    );
  }

  bars.sort((a, b) => a.date.localeCompare(b.date));
  return bars;
}

async function fetchTimeSeriesViaYahooSgdX(params: {
  queryStart: string;
  queryEnd: string;
  fetchImpl?: typeof fetch;
}): Promise<HistoricalFxDailyBar[]> {
  const [startY, startM, startD] = params.queryStart.split("-").map(Number);
  const [endY, endM, endD] = params.queryEnd.split("-").map(Number);

  const period1 = Math.floor(Date.UTC(startY, startM - 1, startD, 0, 0, 0) / 1000);
  const period2 =
    Math.floor(Date.UTC(endY, endM - 1, endD, 23, 59, 59) / 1000) + 86400;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/SGD%3DX?interval=1d&period1=${period1}&period2=${period2}`;
  const payload = await fetchProviderJson<YahooFxChartResponse>({
    provider: "Yahoo Finance",
    url,
    timeoutMs: 8000,
    fetchImpl: params.fetchImpl,
  });

  const result = payload.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  const byDate = new Map<string, HistoricalFxDailyBar>();

  for (let idx = 0; idx < timestamps.length; idx += 1) {
    const closeVal = closes[idx];
    const ts = timestamps[idx];
    if (
      closeVal === null ||
      closeVal === undefined ||
      !Number.isFinite(closeVal) ||
      closeVal <= 0 ||
      typeof ts !== "number"
    ) {
      continue;
    }
    const isoDate = new Date(ts * 1000).toISOString().slice(0, 10);
    byDate.set(isoDate, {
      date: isoDate,
      fromCurrency: "USD",
      toCurrency: "SGD",
      rate: toDecimalString(toDecimal(closeVal).toDecimalPlaces(6), 6),
      source: "yahoo",
    });
  }

  const bars = [...byDate.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  if (bars.length === 0) {
    throw new MarketDataError(
      "not_found",
      "Yahoo Finance",
      `No fallback USD/SGD daily bars found for ${params.queryStart}..${params.queryEnd}.`,
    );
  }
  return bars;
}

/**
 * Fetches daily historical `USD -> SGD` exchange rates across `[startDate, endDate]`,
 * automatically padding 14 calendar days before `startDate` so weekend and
 * public-holiday trades at the beginning of the window always resolve to the
 * nearest prior business day.
 */
export async function fetchUsdToSgdTimeSeries(params: {
  startDate: string;
  endDate: string;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<HistoricalFxDailyBar[]> {
  const todaySgt = getSingaporeDateString(params.now ?? new Date());
  const clampedEnd = params.endDate > todaySgt ? todaySgt : params.endDate;
  const effectiveStart =
    params.startDate > clampedEnd ? clampedEnd : params.startDate;

  // Step back 14 calendar days so weekends/holidays always have prior business days.
  const queryStart = shiftIsoCalendarDays(effectiveStart, -14);

  try {
    return await fetchTimeSeriesViaFrankfurter({
      queryStart,
      queryEnd: clampedEnd,
      fetchImpl: params.fetchImpl,
    });
  } catch (primaryError) {
    try {
      return await fetchTimeSeriesViaYahooSgdX({
        queryStart,
        queryEnd: clampedEnd,
        fetchImpl: params.fetchImpl,
      });
    } catch {
      throw primaryError;
    }
  }
}


