/**
 * Server-side stock price fetcher (latest quote + historical date lookup).
 *
 * Primary source: Yahoo Finance `/v8/finance/chart/{symbol}`.
 * Fallback 1 (latest US quote): Finnhub `/api/v1/quote` when `FINNHUB_API_KEY` is set.
 * Fallback 2 (historical/EOD): Stooq daily CSV `/q/d/l/`.
 *
 * Every returned price uses exact decimal strings (never floating-point math)
 * and carries explicit freshness metadata (`priceStatus`, `asOf`, `freshnessLabel`).
 */
import { getEnv } from "@/lib/env";
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

export type PriceMarketStatus =
  | "live"
  | "delayed"
  | "last_close"
  | "historical";

export interface StockPriceQuote {
  symbol: string;
  price: string;
  previousClose: string | null;
  currency: "USD" | "SGD";
  exchangeCode: string;
  /** ISO-8601 UTC timestamp of when the market price was recorded. */
  asOf: string;
  /** Effective market date (`YYYY-MM-DD`) of the quote or historical close. */
  effectiveDate: string;
  priceStatus: PriceMarketStatus;
  /** Human-readable badge such as `"Last close, 6 Nov"` or `"Delayed ~15 min"`. */
  freshnessLabel: string;
  source: string;
}

const LATEST_QUOTE_OPEN_TTL_MS = 30 * 1000; // 30 seconds while session open
const LATEST_QUOTE_CLOSED_TTL_MS = 5 * 60 * 1000; // 5 minutes when session closed
const HISTORICAL_QUOTE_TTL_MS = 60 * 60 * 1000; // 1 hour
const NOT_FOUND_QUOTE_TTL_MS = 15 * 60 * 1000; // 15 minutes cooldown for unlisted tickers
const STOOQ_TIMEOUT_MS = 5000;
const quoteCache = new TtlCache<StockPriceQuote>(400, "quotes");
const notFoundQuoteCache = new TtlCache<string>(200, "quotes-not-found");

export function getCachedStockPrice(rawSymbol: string): StockPriceQuote | undefined {
  const symbol = rawSymbol.trim().toUpperCase();
  if (!symbol) return undefined;
  return quoteCache.get(`${symbol}|latest`);
}

interface YahooChartResponse {
  chart?: {
    result?: {
      meta?: {
        symbol?: string;
        currency?: string;
        exchangeName?: string;
        regularMarketPrice?: number;
        regularMarketTime?: number;
        chartPreviousClose?: number;
        previousClose?: number;
        exchangeTimezoneName?: string;
      };
      timestamp?: number[];
      indicators?: {
        quote?: {
          close?: (number | null)[];
        }[];
      };
    }[];
    error?: {
      code?: string;
      description?: string;
    } | null;
  };
}

interface FinnhubQuoteResponse {
  c?: number; // current price
  pc?: number; // previous close
  t?: number; // unix timestamp
}

const MONTH_SHORT_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Formats `2026-11-06` into `"6 Nov"` (same year) or `"6 Nov 2021"` (past year). */
export function formatShortMarketDate(
  isoDate: string,
  referenceYear?: number,
): string {
  const [yearStr, monthStr, dayStr] = isoDate.split("-");
  const year = Number(yearStr);
  const monthIndex = Number(monthStr) - 1;
  const day = Number(dayStr);
  const monthLabel = MONTH_SHORT_NAMES[monthIndex] ?? monthStr;
  const currentYear = referenceYear ?? new Date().getUTCFullYear();

  if (year === currentYear) {
    return `${day} ${monthLabel}`;
  }
  return `${day} ${monthLabel} ${year}`;
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

async function fetchLatestViaYahoo(
  symbol: string,
  now: Date,
  fetchImpl?: typeof fetch,
): Promise<StockPriceQuote> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?interval=1d&range=5d`;

  const payload = await fetchProviderJson<YahooChartResponse>({
    provider: "Yahoo Finance",
    url,
    fetchImpl,
  });

  const result = payload.chart?.result?.[0];
  const meta = result?.meta;
  if (
    !meta ||
    typeof meta.regularMarketPrice !== "number" ||
    !Number.isFinite(meta.regularMarketPrice)
  ) {
    throw new MarketDataError(
      "not_found",
      "Yahoo Finance",
      `No price available for "${symbol}".`,
    );
  }

  const rawCurrency = (meta.currency ?? "").toUpperCase();
  if (rawCurrency !== "USD" && rawCurrency !== "SGD") {
    throw new MarketDataError(
      "upstream",
      "Yahoo Finance",
      `Unsupported quote currency "${rawCurrency || "unknown"}" for ${symbol}.`,
    );
  }

  const region = inferMarketRegion(meta.symbol ?? symbol, meta.exchangeName);
  const session = getMarketSessionStatus(region, now);
  const exchangeTimeZone =
    meta.exchangeTimezoneName ??
    (region === "SG" ? "Asia/Singapore" : "America/New_York");

  const marketUnixSeconds =
    typeof meta.regularMarketTime === "number" && meta.regularMarketTime > 0
      ? meta.regularMarketTime
      : Math.floor(now.getTime() / 1000);

  const asOfDate = new Date(marketUnixSeconds * 1000);
  const effectiveDate = toIsoDateInTimezone(
    marketUnixSeconds,
    exchangeTimeZone,
  );
  const referenceYear = Number(getSingaporeDateString(now).slice(0, 4));

  let priceStatus: PriceMarketStatus;
  let freshnessLabel: string;

  if (!session.isOpen) {
    priceStatus = "last_close";
    freshnessLabel = `Last close, ${formatShortMarketDate(effectiveDate, referenceYear)}`;
  } else if (region === "SG") {
    // Free SGX feeds are ~15 minutes delayed during trading hours.
    priceStatus = "delayed";
    freshnessLabel = "Delayed ~15 min";
  } else {
    const ageSeconds = Math.max(
      0,
      Math.floor(now.getTime() / 1000) - marketUnixSeconds,
    );
    if (ageSeconds <= 120) {
      priceStatus = "live";
      freshnessLabel = "Live";
    } else {
      priceStatus = "delayed";
      freshnessLabel = "Delayed ~15 min";
    }
  }

  const prevCloseNum = meta.chartPreviousClose ?? meta.previousClose;
  const previousClose =
    typeof prevCloseNum === "number" && Number.isFinite(prevCloseNum)
      ? toDecimalString(toDecimal(prevCloseNum), 6)
      : null;

  return {
    symbol: meta.symbol ?? symbol,
    price: toDecimalString(toDecimal(meta.regularMarketPrice), 6),
    previousClose,
    currency: rawCurrency,
    exchangeCode:
      region === "SG" ? "SES" : (meta.exchangeName ?? "NMS").toUpperCase(),
    asOf: asOfDate.toISOString(),
    effectiveDate,
    priceStatus,
    freshnessLabel,
    source: "yahoo",
  };
}

async function fetchLatestViaFinnhub(
  symbol: string,
  apiKey: string,
  now: Date,
  fetchImpl?: typeof fetch,
): Promise<StockPriceQuote> {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(
    symbol,
  )}`;
  const payload = await fetchProviderJson<FinnhubQuoteResponse>({
    provider: "Finnhub",
    url,
    headers: { "X-Finnhub-Token": apiKey },
    fetchImpl,
  });

  if (typeof payload.c !== "number" || payload.c <= 0) {
    throw new MarketDataError(
      "not_found",
      "Finnhub",
      `No quote returned for "${symbol}".`,
    );
  }

  const session = getMarketSessionStatus("US", now);
  const marketUnixSeconds =
    typeof payload.t === "number" && payload.t > 0
      ? payload.t
      : Math.floor(now.getTime() / 1000);
  const effectiveDate = toIsoDateInTimezone(
    marketUnixSeconds,
    "America/New_York",
  );
  const referenceYear = Number(getSingaporeDateString(now).slice(0, 4));

  const priceStatus: PriceMarketStatus = session.isOpen ? "live" : "last_close";
  const freshnessLabel = session.isOpen
    ? "Live"
    : `Last close, ${formatShortMarketDate(effectiveDate, referenceYear)}`;

  return {
    symbol,
    price: toDecimalString(toDecimal(payload.c), 6),
    previousClose:
      typeof payload.pc === "number" && payload.pc > 0
        ? toDecimalString(toDecimal(payload.pc), 6)
        : null,
    currency: "USD",
    exchangeCode: "NMS",
    asOf: new Date(marketUnixSeconds * 1000).toISOString(),
    effectiveDate,
    priceStatus,
    freshnessLabel,
    source: "finnhub",
  };
}

async function fetchHistoricalViaYahoo(
  symbol: string,
  targetDate: string,
  now: Date,
  fetchImpl?: typeof fetch,
): Promise<StockPriceQuote> {
  const [yearStr, monthStr, dayStr] = targetDate.split("-");
  const targetEndUtc = Date.UTC(
    Number(yearStr),
    Number(monthStr) - 1,
    Number(dayStr),
    23,
    59,
    59,
  );
  // Look back 10 calendar days before `targetDate` so weekends/holidays snap
  // cleanly to the most recent trading session on or before `targetDate`.
  const period2 = Math.floor(targetEndUtc / 1000) + 86400;
  const period1 = period2 - 12 * 86400;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?interval=1d&period1=${period1}&period2=${period2}`;

  const payload = await fetchProviderJson<YahooChartResponse>({
    provider: "Yahoo Finance",
    url,
    fetchImpl,
  });

  const result = payload.chart?.result?.[0];
  const meta = result?.meta;
  const timestamps = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];

  if (!meta || timestamps.length === 0 || closes.length === 0) {
    throw new MarketDataError(
      "not_found",
      "Yahoo Finance",
      `No historical price found for ${symbol} on or before ${targetDate}.`,
    );
  }

  const rawCurrency = (meta.currency ?? "").toUpperCase();
  if (rawCurrency !== "USD" && rawCurrency !== "SGD") {
    throw new MarketDataError(
      "upstream",
      "Yahoo Finance",
      `Unsupported currency "${rawCurrency}" for ${symbol}.`,
    );
  }

  const region = inferMarketRegion(meta.symbol ?? symbol, meta.exchangeName);
  const exchangeTimeZone =
    meta.exchangeTimezoneName ??
    (region === "SG" ? "Asia/Singapore" : "America/New_York");

  // Walk backwards from the newest bar to pick the latest session <= targetDate.
  let chosenClose: number | null = null;
  let chosenTimestamp = 0;
  let chosenDate = "";

  for (let idx = timestamps.length - 1; idx >= 0; idx -= 1) {
    const barClose = closes[idx];
    const barTimestamp = timestamps[idx];
    if (
      barClose === null ||
      barClose === undefined ||
      !Number.isFinite(barClose)
    ) {
      continue;
    }
    const barDate = toIsoDateInTimezone(barTimestamp, exchangeTimeZone);
    if (barDate <= targetDate) {
      chosenClose = barClose;
      chosenTimestamp = barTimestamp;
      chosenDate = barDate;
      break;
    }
  }

  if (chosenClose === null) {
    throw new MarketDataError(
      "not_found",
      "Yahoo Finance",
      `No trading session found for ${symbol} on or before ${targetDate}.`,
    );
  }

  // Yahoo encodes historical daily bars as 32-bit floats (e.g. 50.389999389);
  // rounding to 4 decimal places restores clean exchange tick prices like 50.39
  // while preserving sub-cent SGX ticks like 0.919 or 5.246.
  const cleanedClose = toDecimal(chosenClose).toDecimalPlaces(4);
  const referenceYear = Number(getSingaporeDateString(now).slice(0, 4));
  return {
    symbol: meta.symbol ?? symbol,
    price: toDecimalString(cleanedClose, 4),
    previousClose: null,
    currency: rawCurrency,
    exchangeCode:
      region === "SG" ? "SES" : (meta.exchangeName ?? "NMS").toUpperCase(),
    asOf: new Date(chosenTimestamp * 1000).toISOString(),
    effectiveDate: chosenDate,
    priceStatus: "historical",
    freshnessLabel: `Close on ${formatShortMarketDate(chosenDate, referenceYear)}`,
    source: "yahoo",
  };
}

export function toStooqSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  if (upper === "^GSPC") {
    return "^spx";
  }
  if (upper === "^IXIC") {
    return "^ndq";
  }
  if (upper === "^DJI") {
    return "^dji";
  }
  if (upper === "^STI") {
    return "^sti";
  }
  if (upper.startsWith("^")) {
    return upper.toLowerCase();
  }
  if (upper.endsWith(".SI")) {
    return `${upper.slice(0, -3).toLowerCase()}.sg`;
  }
  return `${upper.toLowerCase()}.us`;
}

/** Fallback end-of-day CSV fetch from Stooq (`/q/d/l/`). */
async function fetchViaStooqCsv(
  symbol: string,
  targetDate: string | null,
  now: Date,
  fetchImpl?: typeof fetch,
): Promise<StockPriceQuote> {
  const upper = symbol.toUpperCase();
  const isSgx = upper.endsWith(".SI") || upper === "^STI";
  const stooqTicker = toStooqSymbol(symbol);

  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqTicker)}&i=d`;
  const fetchFn = fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), STOOQ_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: { "User-Agent": BROWSER_USER_AGENT },
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (error) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    throw new MarketDataError(
      "network",
      "Stooq",
      isAbort
        ? "Fallback price provider timed out."
        : "Could not reach fallback price provider.",
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new MarketDataError(
      "upstream",
      "Stooq",
      `Fallback provider returned ${response.status}.`,
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
      `No end-of-day data available for ${symbol}.`,
    );
  }

  // CSV columns: Date,Open,High,Low,Close,Volume sorted ascending by Date.
  const cutoff = targetDate ?? "9999-12-31";
  let matchedDate = "";
  let matchedClose = "";

  for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
    const cols = lines[idx].split(",");
    if (cols.length >= 5 && cols[0] <= cutoff && cols[4]) {
      matchedDate = cols[0];
      matchedClose = cols[4];
      break;
    }
  }

  if (!matchedDate || !matchedClose) {
    throw new MarketDataError(
      "not_found",
      "Stooq",
      `No price found for ${symbol} on or before ${cutoff}.`,
    );
  }

  const referenceYear = Number(getSingaporeDateString(now).slice(0, 4));
  const isHistorical = targetDate !== null;

  return {
    symbol: upper,
    price: toDecimalString(toDecimal(matchedClose), 6),
    previousClose: null,
    currency: isSgx ? "SGD" : "USD",
    exchangeCode: isSgx ? "SES" : "NMS",
    asOf: `${matchedDate}T16:00:00.000Z`,
    effectiveDate: matchedDate,
    priceStatus: isHistorical ? "historical" : "last_close",
    freshnessLabel: isHistorical
      ? `Close on ${formatShortMarketDate(matchedDate, referenceYear)}`
      : `Last close, ${formatShortMarketDate(matchedDate, referenceYear)}`,
    source: "stooq",
  };
}

export interface FetchStockPriceOptions {
  /** Optional trade date (`YYYY-MM-DD`). Past dates fetch historical closes. */
  date?: string | null;
  now?: Date;
  fetchImpl?: typeof fetch;
  skipCache?: boolean;
  /** Optional circuit-breaker chain (defaults to `globalProviderChain`). */
  chain?: ProviderChain;
}

/**
 * Fetches either the latest price or a backdated historical closing price for
 * `symbol`. Never fabricates a price — throws `MarketDataError` on failure.
 */
export async function fetchStockPrice(
  rawSymbol: string,
  options: FetchStockPriceOptions = {},
): Promise<StockPriceQuote> {
  const symbol = rawSymbol.trim();
  if (!symbol) {
    throw new MarketDataError("not_found", "Yahoo Finance", "Symbol is empty.");
  }

  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const todaySgt = getSingaporeDateString(now);
  const requestedDate = options.date?.trim() || null;
  const isBackdated = requestedDate !== null && requestedDate < todaySgt;

  const cacheKey = `${symbol.toUpperCase()}|${isBackdated ? requestedDate : "latest"}`;
  const session = isBackdated
    ? null
    : getMarketSessionStatus(inferMarketRegion(symbol), now);
  const ttl = isBackdated
    ? HISTORICAL_QUOTE_TTL_MS
    : session?.isOpen
      ? LATEST_QUOTE_OPEN_TTL_MS
      : LATEST_QUOTE_CLOSED_TTL_MS;
  const activeChain = options.chain ?? globalProviderChain;

  const execute = async (): Promise<StockPriceQuote> => {
    if (isBackdated && requestedDate !== null) {
      const historicalSteps: ProviderStep<StockPriceQuote>[] = [
        {
          provider: "yahoo",
          execute: () =>
            fetchHistoricalViaYahoo(
              symbol,
              requestedDate,
              now,
              options.fetchImpl,
            ),
        },
        {
          provider: "stooq",
          execute: () =>
            fetchViaStooqCsv(symbol, requestedDate, now, options.fetchImpl),
        },
      ];
      const resolved = await activeChain.execute(historicalSteps, nowMs);
      return resolved.value;
    }

    // Latest price path: Yahoo -> Finnhub (US stocks/ETFs) -> Stooq EOD
    const region = inferMarketRegion(symbol);
    let finnhubKey: string | undefined;
    try {
      finnhubKey = getEnv().FINNHUB_API_KEY;
    } catch {
      finnhubKey = process.env.FINNHUB_API_KEY;
    }

    const latestSteps: ProviderStep<StockPriceQuote>[] = [
      {
        provider: "yahoo",
        execute: () => fetchLatestViaYahoo(symbol, now, options.fetchImpl),
      },
    ];

    if (region === "US" && !symbol.startsWith("^") && finnhubKey) {
      const apiKey = finnhubKey;
      latestSteps.push({
        provider: "finnhub",
        execute: () =>
          fetchLatestViaFinnhub(symbol, apiKey, now, options.fetchImpl),
      });
    }

    latestSteps.push({
      provider: "stooq",
      execute: () => fetchViaStooqCsv(symbol, null, now, options.fetchImpl),
    });

    const resolved = await activeChain.execute(latestSteps, nowMs);
    return resolved.value;
  };

  if (!options.skipCache && !options.fetchImpl) {
    const negReason = notFoundQuoteCache.get(cacheKey, nowMs);
    if (negReason) {
      throw new MarketDataError("not_found", "Cache", negReason);
    }
  }

  const runFetch = async (): Promise<StockPriceQuote> => {
    try {
      return await execute();
    } catch (error) {
      if (
        !options.skipCache &&
        !options.fetchImpl &&
        error instanceof MarketDataError &&
        error.kind === "not_found"
      ) {
        notFoundQuoteCache.set(
          cacheKey,
          error.message,
          NOT_FOUND_QUOTE_TTL_MS,
          nowMs,
        );
      }
      throw error;
    }
  };

  return options.skipCache
    ? runFetch()
    : quoteCache.getOrFetch(cacheKey, ttl, runFetch);
}

export function clearQuoteCache(): void {
  quoteCache.clear();
  notFoundQuoteCache.clear();
  globalProviderChain.reset();
}
