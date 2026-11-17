/**
 * TradingView Public Scanner & Symbol Search Provider for SGX (`.SI` & `^STI`).
 *
 * Supplements Yahoo Finance & Stooq for Singapore Exchange equities, S-REITs,
 * ETFs, Singapore Depository Receipts (SDRs), USD-denominated SGX counters,
 * and Straits Times Index quotes without requiring an API key.
 */
import { toDecimal, toDecimalString } from "@/lib/finance/decimal";
import { fetchProviderJson, MarketDataError } from "@/lib/market-data/errors";
import {
  formatShortMarketDate,
  getMarketSessionStatus,
  getSingaporeDateString,
} from "@/lib/market-data/hours";
import type {
  PriceMarketStatus,
  StockPriceQuote,
} from "@/lib/market-data/quotes";
import type { SymbolSearchMatch } from "@/lib/market-data/search";

const TV_SGX_SCAN_URL = "https://scanner.tradingview.com/singapore/scan";
const TV_US_SCAN_URL = "https://scanner.tradingview.com/america/scan";
const TV_UK_SCAN_URL = "https://scanner.tradingview.com/uk/scan";
const TV_CRYPTO_SCAN_URL = "https://scanner.tradingview.com/crypto/scan";
const TV_GLOBAL_SCAN_URL = "https://scanner.tradingview.com/global/scan";
const TV_SYMBOL_SEARCH_URL =
  "https://symbol-search.tradingview.com/symbol_search/v3/";
const TV_CHART_WS_URL = "wss://data.tradingview.com/socket.io/websocket";
const TV_WS_TIMEOUT_MS = 10_000;

const TV_INDEX_CHART_TARGETS: Record<
  string,
  { ticker: string; currency: "USD" | "SGD"; timezone: string }
> = {
  "^STI": { ticker: "TVC:STI", currency: "SGD", timezone: "Asia/Singapore" },
  "^GSPC": { ticker: "SP:SPX", currency: "USD", timezone: "America/New_York" },
  "^IXIC": {
    ticker: "NASDAQ:IXIC",
    currency: "USD",
    timezone: "America/New_York",
  },
  "^DJI": { ticker: "TVC:DJI", currency: "USD", timezone: "America/New_York" },
};

const TV_US_PREFERRED_EXCHANGES = new Set([
  "NASDAQ",
  "NYSE",
  "AMEX",
  "ARCA",
  "NYSE ARCA",
  "BATS",
  "OTC",
]);

const TV_HEADERS: Record<string, string> = {
  Origin: "https://www.tradingview.com",
  Referer: "https://www.tradingview.com/",
};

const SCAN_COLUMNS_QUOTE = [
  "name",
  "description",
  "close",
  "change",
  "change_abs",
  "currency",
  "exchange",
  "update_mode",
  "time",
  "pricescale",
] as const;

const SCAN_COLUMNS_FUNDAMENTALS = [
  "name",
  "description",
  "currency",
  "market_cap_basic",
  "price_earnings_ttm",
  "dividends_yield_current",
  "dividend_yield_recent",
  "price_52_week_high",
  "price_52_week_low",
  "beta_1_year",
  "average_volume_30d_calc",
  "sector",
  "industry",
  "type",
  "subtype",
  "aum",
  "market_cap_calc",
] as const;

const SCAN_COLUMNS_VERIFY = [
  "name",
  "description",
  "type",
  "subtype",
  "currency",
  "exchange",
] as const;

interface TradingViewScanResponse {
  totalCount?: number;
  data?: {
    s?: string;
    d?: unknown[];
  }[];
}

interface TradingViewSearchResponse {
  symbols?: {
    symbol?: string;
    description?: string;
    type?: string;
    exchange?: string;
    currency_code?: string;
  }[];
}

export interface TradingViewSgxTarget {
  endpoint: string;
  ticker: string;
}

export interface TradingViewFundamentalsResult {
  name: string | null;
  currency: "USD" | "SGD" | null;
  marketCap: string | null;
  peTrailing: string | null;
  dividendYieldPercent: string | null;
  fiftyTwoWeekHigh: string | null;
  fiftyTwoWeekLow: string | null;
  beta: string | null;
  averageVolume: string | null;
  sector: string | null;
  industry: string | null;
}

export function toTradingViewSgxTarget(
  rawSymbol: string,
): TradingViewSgxTarget | null {
  const upper = rawSymbol.trim().toUpperCase();
  if (upper === "^STI") {
    return { endpoint: TV_GLOBAL_SCAN_URL, ticker: "TVC:STI" };
  }
  if (upper.endsWith(".SI") && upper.length > 3) {
    return {
      endpoint: TV_SGX_SCAN_URL,
      ticker: `SGX:${upper.slice(0, -3)}`,
    };
  }
  return null;
}

function toSgtIsoDate(unixSeconds: number): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date(unixSeconds * 1000));
}

function resolvePriceDecimals(pricescale: unknown): number {
  if (typeof pricescale === "number" && Number.isFinite(pricescale) && pricescale >= 10) {
    const exp = Math.round(Math.log10(pricescale));
    if (Math.pow(10, exp) === pricescale && exp >= 2 && exp <= 6) {
      return exp;
    }
  }
  return 4;
}

function safePositiveDecimalString(
  raw: unknown,
  decimals: number = 4,
): string | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return null;
  }
  return toDecimalString(toDecimal(raw).toDecimalPlaces(decimals), decimals);
}

function safeSignedDecimalString(
  raw: unknown,
  decimals: number = 2,
): string | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return null;
  }
  return toDecimalString(toDecimal(raw).toDecimalPlaces(decimals), decimals);
}

async function queryScannerRow(params: {
  endpoint: string;
  ticker?: string;
  tickers?: readonly string[];
  columns: readonly string[];
  fetchImpl?: typeof fetch;
}): Promise<unknown[] | null> {
  const tickers = params.tickers ?? (params.ticker ? [params.ticker] : []);
  if (tickers.length === 0) {
    return null;
  }
  const payload = await fetchProviderJson<TradingViewScanResponse>({
    provider: "TradingView",
    url: params.endpoint,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...TV_HEADERS,
    },
    body: JSON.stringify({
      symbols: { tickers },
      columns: params.columns,
    }),
    timeoutMs: 6000,
    fetchImpl: params.fetchImpl,
  });

  const row = payload.data?.[0]?.d;
  return Array.isArray(row) ? row : null;
}

/**
 * Fetches a Singapore Exchange (`.SI` or `^STI`) quote via TradingView's
 * scanner JSON API. Throws structured `MarketDataError` on miss or failure.
 */
export async function fetchLatestViaTradingViewSgx(
  symbol: string,
  now: Date,
  fetchImpl?: typeof fetch,
): Promise<StockPriceQuote> {
  const target = toTradingViewSgxTarget(symbol);
  if (!target) {
    throw new MarketDataError(
      "not_found",
      "TradingView",
      `TradingView SGX provider only handles Singapore symbols (received "${symbol}").`,
    );
  }

  const row = await queryScannerRow({
    endpoint: target.endpoint,
    ticker: target.ticker,
    columns: SCAN_COLUMNS_QUOTE,
    fetchImpl,
  });

  if (!row) {
    throw new MarketDataError(
      "not_found",
      "TradingView",
      `No SGX quote found on TradingView for "${symbol}".`,
    );
  }

  const rawClose = row[2];
  const rawChangeAbs = row[4];
  const rawCurrency = typeof row[5] === "string" ? row[5].toUpperCase() : "";
  const updateMode = typeof row[7] === "string" ? row[7].toLowerCase() : "";
  const barUnix = typeof row[8] === "number" && row[8] > 0 ? row[8] : null;
  const decimals = resolvePriceDecimals(row[9]);

  if (typeof rawClose !== "number" || !Number.isFinite(rawClose) || rawClose <= 0) {
    throw new MarketDataError(
      "not_found",
      "TradingView",
      `No valid price returned by TradingView for "${symbol}".`,
    );
  }

  if (rawCurrency !== "SGD" && rawCurrency !== "USD") {
    throw new MarketDataError(
      "upstream",
      "TradingView",
      `Unsupported currency "${rawCurrency || "unknown"}" returned for "${symbol}".`,
    );
  }

  const closeDec = toDecimal(rawClose).toDecimalPlaces(decimals);
  let previousClose: string | null = null;
  if (typeof rawChangeAbs === "number" && Number.isFinite(rawChangeAbs)) {
    const prevDec = toDecimal(rawClose)
      .minus(toDecimal(rawChangeAbs))
      .toDecimalPlaces(decimals);
    if (prevDec.gt(0)) {
      previousClose = toDecimalString(prevDec, decimals);
    }
  }

  const session = getMarketSessionStatus("SG", now);
  const referenceYear = Number(getSingaporeDateString(now).slice(0, 4));
  const effectiveDate = barUnix
    ? toSgtIsoDate(barUnix)
    : getSingaporeDateString(now);

  let priceStatus: PriceMarketStatus;
  let freshnessLabel: string;
  if (!session.isOpen) {
    priceStatus = "last_close";
    freshnessLabel = `Last close, ${formatShortMarketDate(effectiveDate, referenceYear)}`;
  } else if (updateMode.includes("delayed")) {
    priceStatus = "delayed";
    freshnessLabel = "Delayed ~10 min";
  } else {
    priceStatus = "live";
    freshnessLabel = "Live";
  }

  return {
    symbol: symbol.trim().toUpperCase(),
    price: toDecimalString(closeDec, decimals),
    previousClose,
    currency: rawCurrency,
    exchangeCode: "SES",
    asOf: barUnix
      ? new Date(barUnix * 1000).toISOString()
      : now.toISOString(),
    effectiveDate,
    priceStatus,
    freshnessLabel,
    source: "tradingview",
  };
}

function resolveTradingViewFundamentalsTargets(rawSymbol: string): {
  endpoint: string;
  tickers: string[];
} | null {
  const upper = rawSymbol.trim().toUpperCase();
  if (!upper || upper.startsWith("^")) {
    return null;
  }
  if (upper.endsWith(".SI") && upper.length > 3) {
    return {
      endpoint: TV_SGX_SCAN_URL,
      tickers: [`SGX:${upper.slice(0, -3)}`],
    };
  }
  if (upper.endsWith(".L") && upper.length > 2) {
    return {
      endpoint: TV_UK_SCAN_URL,
      tickers: [`LSE:${upper.slice(0, -2)}`],
    };
  }
  const cryptoMatch = /^([A-Z0-9]{2,10})-(USD|SGD)$/i.exec(upper);
  if (cryptoMatch) {
    const coin = cryptoMatch[1];
    return {
      endpoint: TV_CRYPTO_SCAN_URL,
      tickers: [
        `CRYPTO:${coin}USD`,
        `COINBASE:${coin}USD`,
        `BINANCE:${coin}USDT`,
      ],
    };
  }
  const tvSym = upper.replace(/-/g, ".");
  return {
    endpoint: TV_US_SCAN_URL,
    tickers: [
      `NASDAQ:${tvSym}`,
      `NYSE:${tvSym}`,
      `AMEX:${tvSym}`,
      `OTC:${tvSym}`,
    ],
  };
}

/**
 * Fetches company/REIT/ETF key statistics for any US, SGX (`.SI`), or UK LSE
 * (`.L`) ticker from TradingView's public scanner. Never throws (returns `null`
 * on failure).
 */
export async function fetchFundamentalsViaTradingView(
  symbol: string,
  fetchImpl?: typeof fetch,
): Promise<TradingViewFundamentalsResult | null> {
  const target = resolveTradingViewFundamentalsTargets(symbol);
  if (!target) {
    return null;
  }

  try {
    const row = await queryScannerRow({
      endpoint: target.endpoint,
      tickers: target.tickers,
      columns: SCAN_COLUMNS_FUNDAMENTALS,
      fetchImpl,
    });
    if (!row) {
      return null;
    }

    const description =
      typeof row[1] === "string" && row[1].trim() ? row[1].trim() : null;
    const rawCur = typeof row[2] === "string" ? row[2].toUpperCase() : "";
    const isPence = row[2] === "GBX" || row[2] === "GBp";
    const currency = rawCur === "SGD" ? "SGD" : "USD";

    const dividendYieldRaw =
      typeof row[5] === "number" && Number.isFinite(row[5]) && row[5] >= 0
        ? row[5]
        : typeof row[6] === "number" && Number.isFinite(row[6]) && row[6] >= 0
          ? row[6]
          : null;

    const avgVolRaw =
      typeof row[10] === "number" && Number.isFinite(row[10]) && row[10] > 0
        ? Math.round(row[10])
        : null;

    const marketCapOrAum =
      safePositiveDecimalString(row[3], 0) ??
      safePositiveDecimalString(row[15], 0) ??
      safePositiveDecimalString(row[16], 0);

    const rawHigh =
      typeof row[7] === "number" && Number.isFinite(row[7])
        ? isPence
          ? row[7] / 100
          : row[7]
        : null;
    const rawLow =
      typeof row[8] === "number" && Number.isFinite(row[8])
        ? isPence
          ? row[8] / 100
          : row[8]
        : null;

    let sector =
      typeof row[11] === "string" && row[11].trim() ? row[11].trim() : null;
    let industry =
      typeof row[12] === "string" && row[12].trim() ? row[12].trim() : null;
    const typeLower =
      typeof row[13] === "string" ? row[13].trim().toLowerCase() : "";
    const subtypeLower =
      typeof row[14] === "string" ? row[14].trim().toLowerCase() : "";

    if (!sector && !industry) {
      if (
        typeLower === "fund" ||
        subtypeLower.includes("etf") ||
        /\b(etf|ucits)\b/i.test(description ?? "")
      ) {
        sector = "Exchange-Traded Fund";
        industry = "ETF";
      } else if (
        typeLower === "reit" ||
        subtypeLower.includes("reit") ||
        /\b(reit|trust)\b/i.test(description ?? "")
      ) {
        sector = "Finance";
        industry = "Real Estate Investment Trusts";
      }
    }

    return {
      name: description,
      currency,
      marketCap: marketCapOrAum,
      peTrailing: safePositiveDecimalString(row[4], 2),
      dividendYieldPercent:
        dividendYieldRaw !== null
          ? toDecimalString(toDecimal(dividendYieldRaw).toDecimalPlaces(2), 2)
          : null,
      fiftyTwoWeekHigh: safePositiveDecimalString(rawHigh, 4),
      fiftyTwoWeekLow: safePositiveDecimalString(rawLow, 4),
      beta: safeSignedDecimalString(row[9], 2),
      averageVolume: avgVolRaw !== null ? String(avgVolRaw) : null,
      sector,
      industry,
    };
  } catch {
    return null;
  }
}

export const fetchFundamentalsViaTradingViewSgx =
  fetchFundamentalsViaTradingView;

/**
 * Searches Singapore Exchange equities, REITs, ETFs, and SDRs on TradingView.
 */
export async function searchViaTradingViewSgx(
  rawQuery: string,
  fetchImpl?: typeof fetch,
): Promise<SymbolSearchMatch[]> {
  const clean = rawQuery.trim();
  if (!clean) {
    return [];
  }
  const searchText = clean.toUpperCase().endsWith(".SI")
    ? clean.slice(0, -3)
    : clean;
  if (!searchText) {
    return [];
  }

  const url = `${TV_SYMBOL_SEARCH_URL}?text=${encodeURIComponent(
    searchText,
  )}&exchange=SGX&domain=production`;

  const payload = await fetchProviderJson<TradingViewSearchResponse>({
    provider: "TradingView",
    url,
    headers: TV_HEADERS,
    timeoutMs: 6000,
    fetchImpl,
  });

  const results: SymbolSearchMatch[] = [];
  const seen = new Set<string>();

  for (const item of payload.symbols ?? []) {
    const code = (item.symbol ?? "").trim().toUpperCase();
    const name = (item.description ?? "").trim();
    const exchange = (item.exchange ?? "").trim().toUpperCase();
    const currency = (item.currency_code ?? "").trim().toUpperCase();
    const typeLower = (item.type ?? "").trim().toLowerCase();

    if (!code || !name || exchange !== "SGX") {
      continue;
    }
    if (currency !== "SGD" && currency !== "USD") {
      continue;
    }

    const allowed =
      typeLower === "stock" ||
      typeLower === "fund" ||
      typeLower === "etf" ||
      typeLower === "reit" ||
      typeLower === "dr";
    if (!allowed) {
      continue;
    }

    const symbol = code.endsWith(".SI") ? code : `${code}.SI`;
    if (seen.has(symbol)) {
      continue;
    }
    seen.add(symbol);

    const quoteType: "EQUITY" | "ETF" =
      typeLower === "fund" || typeLower === "etf" || /\betf\b/i.test(name)
        ? "ETF"
        : "EQUITY";

    results.push({
      symbol,
      name,
      exchangeCode: "SES",
      exchangeDisplay: "SGX",
      currency: currency === "USD" ? "USD" : "SGD",
      quoteType,
    });
  }

  return results;
}

/**
 * Verifies an exact `.SI` ticker directly via TradingView Singapore Scanner.
 */
export async function verifyExactViaTradingViewSgx(
  symbol: string,
  fetchImpl?: typeof fetch,
): Promise<SymbolSearchMatch | null> {
  const upper = symbol.trim().toUpperCase();
  if (!upper.endsWith(".SI") || upper.length <= 3) {
    return null;
  }
  const target = toTradingViewSgxTarget(upper);
  if (!target) {
    return null;
  }

  try {
    const row = await queryScannerRow({
      endpoint: target.endpoint,
      ticker: target.ticker,
      columns: SCAN_COLUMNS_VERIFY,
      fetchImpl,
    });
    if (!row) {
      return null;
    }

    const name =
      typeof row[1] === "string" && row[1].trim() ? row[1].trim() : null;
    const typeLower = typeof row[2] === "string" ? row[2].toLowerCase() : "";
    const subtypeLower =
      typeof row[3] === "string" ? row[3].toLowerCase() : "";
    const rawCur = typeof row[4] === "string" ? row[4].toUpperCase() : "";

    if (!name || (rawCur !== "SGD" && rawCur !== "USD")) {
      return null;
    }

    const quoteType: "EQUITY" | "ETF" =
      typeLower === "fund" ||
      subtypeLower === "etf" ||
      /\betf\b/i.test(name)
        ? "ETF"
        : "EQUITY";

    return {
      symbol: upper,
      name,
      exchangeCode: "SES",
      exchangeDisplay: "SGX",
      currency: rawCur === "USD" ? "USD" : "SGD",
      quoteType,
    };
  } catch {
    return null;
  }
}

/**
 * Searches London Stock Exchange (`.L` / UCITS ETFs & equities) on TradingView.
 */
export async function searchViaTradingViewLse(
  rawQuery: string,
  fetchImpl?: typeof fetch,
): Promise<SymbolSearchMatch[]> {
  const clean = rawQuery.trim();
  if (!clean) {
    return [];
  }
  const searchText = clean.toUpperCase().endsWith(".L")
    ? clean.slice(0, -2)
    : clean;
  if (!searchText) {
    return [];
  }

  const url = `${TV_SYMBOL_SEARCH_URL}?text=${encodeURIComponent(
    searchText,
  )}&exchange=LSE&domain=production`;

  const payload = await fetchProviderJson<TradingViewSearchResponse>({
    provider: "TradingView",
    url,
    headers: TV_HEADERS,
    timeoutMs: 6000,
    fetchImpl,
  });

  const results: SymbolSearchMatch[] = [];
  const seen = new Set<string>();

  for (const item of payload.symbols ?? []) {
    const code = (item.symbol ?? "").trim().toUpperCase();
    const name = (item.description ?? "").trim();
    const exchange = (item.exchange ?? "").trim().toUpperCase();
    const typeLower = (item.type ?? "").trim().toLowerCase();

    if (!code || !name || (exchange !== "LSE" && exchange !== "LSIN")) {
      continue;
    }

    const allowed =
      typeLower === "stock" ||
      typeLower === "fund" ||
      typeLower === "etf" ||
      typeLower === "reit" ||
      typeLower === "dr";
    if (!allowed) {
      continue;
    }

    const symbol = code.endsWith(".L") ? code : `${code}.L`;
    if (seen.has(symbol)) {
      continue;
    }
    seen.add(symbol);

    const quoteType: "EQUITY" | "ETF" =
      typeLower === "fund" ||
      typeLower === "etf" ||
      /\b(etf|ucits)\b/i.test(name)
        ? "ETF"
        : "EQUITY";

    results.push({
      symbol,
      name,
      exchangeCode: "LSE",
      exchangeDisplay: "LSE",
      currency: "USD",
      quoteType,
    });
  }

  return results;
}

/**
 * Verifies an exact `.L` LSE ticker directly via TradingView UK Scanner.
 */
export async function verifyExactViaTradingViewLse(
  symbol: string,
  fetchImpl?: typeof fetch,
): Promise<SymbolSearchMatch | null> {
  const upper = symbol.trim().toUpperCase();
  if (!upper.endsWith(".L") || upper.length <= 2) {
    return null;
  }
  const base = upper.slice(0, -2);

  try {
    const row = await queryScannerRow({
      endpoint: TV_UK_SCAN_URL,
      ticker: `LSE:${base}`,
      columns: SCAN_COLUMNS_VERIFY,
      fetchImpl,
    });
    if (!row) {
      return null;
    }

    const name =
      typeof row[1] === "string" && row[1].trim() ? row[1].trim() : null;
    const typeLower = typeof row[2] === "string" ? row[2].toLowerCase() : "";
    const subtypeLower =
      typeof row[3] === "string" ? row[3].toLowerCase() : "";

    if (!name) {
      return null;
    }

    const quoteType: "EQUITY" | "ETF" =
      typeLower === "fund" ||
      subtypeLower === "etf" ||
      /\b(etf|ucits)\b/i.test(name)
        ? "ETF"
        : "EQUITY";

    return {
      symbol: upper,
      name,
      exchangeCode: "LSE",
      exchangeDisplay: "LSE",
      currency: "USD",
      quoteType,
    };
  } catch {
    return null;
  }
}

export interface TradingViewDailyBar {
  date: string;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string;
  volume: string | null;
  source: "tradingview";
}

export interface TradingViewWebSocketLike {
  addEventListener: (
    type: "open" | "message" | "error" | "close",
    listener: (event: { data?: unknown; message?: unknown }) => void,
  ) => void;
  send: (data: string) => void;
  close: () => void;
}

interface TradingViewChartTarget {
  ticker: string;
  defaultCurrency: "USD" | "SGD";
  defaultTimezone: string;
}

// Serialize public TradingView WebSocket connections so bulk multi-holding
// syncs do not trigger concurrent HTTP 101 handshake rejections.
let tvChartWsQueue: Promise<void> = Promise.resolve();

function enqueueTvChartSocket<T>(task: () => Promise<T>): Promise<T> {
  const run = tvChartWsQueue.then(task, task);
  tvChartWsQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function encodeTvSocketFrame(payload: unknown): string {
  const encoded = typeof payload === "string" ? payload : JSON.stringify(payload);
  return `~m~${encoded.length}~m~${encoded}`;
}

function parseTvSocketFrames(raw: string): string[] {
  const frames: string[] = [];
  let cursor = 0;
  while (cursor < raw.length && raw.startsWith("~m~", cursor)) {
    const lenStart = cursor + 3;
    const lenEnd = raw.indexOf("~m~", lenStart);
    if (lenEnd === -1) {
      break;
    }
    const len = Number(raw.slice(lenStart, lenEnd));
    if (!Number.isFinite(len) || len < 0) {
      break;
    }
    const bodyStart = lenEnd + 3;
    const bodyEnd = bodyStart + len;
    frames.push(raw.slice(bodyStart, bodyEnd));
    cursor = bodyEnd;
  }
  return frames;
}

function toIsoDateInExchangeTimezone(
  unixSeconds: number,
  timeZone: string,
): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(unixSeconds * 1000));
  } catch {
    return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
  }
}

async function resolveTradingViewChartTarget(
  rawSymbol: string,
  fetchImpl?: typeof fetch,
): Promise<TradingViewChartTarget> {
  const upper = rawSymbol.trim().toUpperCase();
  const knownIndex = TV_INDEX_CHART_TARGETS[upper];
  if (knownIndex) {
    return {
      ticker: knownIndex.ticker,
      defaultCurrency: knownIndex.currency,
      defaultTimezone: knownIndex.timezone,
    };
  }

  if (upper.endsWith(".SI") && upper.length > 3) {
    return {
      ticker: `SGX:${upper.slice(0, -3)}`,
      defaultCurrency: "SGD",
      defaultTimezone: "Asia/Singapore",
    };
  }

  if (upper.endsWith(".L") && upper.length > 2) {
    return {
      ticker: `LSE:${upper.slice(0, -2)}`,
      defaultCurrency: "USD",
      defaultTimezone: "Europe/London",
    };
  }

  const dotVariant = upper.replace(/-/g, ".");
  const payload = await fetchProviderJson<TradingViewSearchResponse>({
    provider: "TradingView",
    url: `${TV_SYMBOL_SEARCH_URL}?text=${encodeURIComponent(dotVariant)}&domain=production`,
    headers: TV_HEADERS,
    timeoutMs: 6000,
    fetchImpl,
  });

  const candidates = payload.symbols ?? [];
  const exactMatches = candidates.filter((item) => {
    const sym = (item.symbol ?? "").trim().toUpperCase();
    const cur = (item.currency_code ?? "").trim().toUpperCase();
    return (
      (sym === upper || sym === dotVariant) &&
      (cur === "USD" || cur === "SGD")
    );
  });

  const preferred =
    exactMatches.find((item) =>
      TV_US_PREFERRED_EXCHANGES.has((item.exchange ?? "").trim().toUpperCase()),
    ) ?? exactMatches[0];

  const exchange = (preferred?.exchange ?? "").trim().toUpperCase();
  const matchedSymbol = (preferred?.symbol ?? "").trim().toUpperCase();
  const cur = (preferred?.currency_code ?? "").trim().toUpperCase();
  if (!exchange || !matchedSymbol) {
    throw new MarketDataError(
      "not_found",
      "TradingView",
      `No TradingView chart symbol found for "${rawSymbol}".`,
    );
  }

  return {
    ticker: `${exchange}:${matchedSymbol}`,
    defaultCurrency: cur === "SGD" ? "SGD" : "USD",
    defaultTimezone: cur === "SGD" ? "Asia/Singapore" : "America/New_York",
  };
}

/**
 * Fetches multi-year (up to ~5-8Y+) split-adjusted daily OHLCV bars from
 * TradingView's public WebSocket feed without requiring an API key.
 */
export async function fetchDailyBarsViaTradingView(params: {
  symbol: string;
  startDate: string;
  endDate: string;
  fetchImpl?: typeof fetch;
  wsFactory?: (url: string) => TradingViewWebSocketLike;
}): Promise<{ currency: "USD" | "SGD"; bars: TradingViewDailyBar[] }> {
  if (typeof params.fetchImpl === "function" && !params.wsFactory) {
    throw new MarketDataError(
      "network",
      "TradingView",
      "TradingView WebSocket history skipped in mocked-HTTP mode.",
    );
  }

  const target = await resolveTradingViewChartTarget(
    params.symbol,
    params.fetchImpl,
  );

  const startMs = Date.parse(`${params.startDate}T00:00:00Z`);
  const calendarDays = Number.isFinite(startMs)
    ? Math.max(30, Math.ceil((Date.now() - startMs) / 86_400_000))
    : 365;
  const barsToRequest = Math.min(
    5000,
    Math.max(60, Math.ceil(calendarDays * 0.85) + 40),
  );

  const openSocket = (): TradingViewWebSocketLike => {
    if (params.wsFactory) {
      return params.wsFactory(TV_CHART_WS_URL);
    }
    if (typeof WebSocket === "undefined") {
      throw new MarketDataError(
        "network",
        "TradingView",
        "Global WebSocket runtime is unavailable for TradingView history.",
      );
    }
    const WsCtor = WebSocket as unknown as new (
      url: string,
      options?: { headers?: Record<string, string> },
    ) => TradingViewWebSocketLike;
    return new WsCtor(TV_CHART_WS_URL, { headers: TV_HEADERS });
  };

  return enqueueTvChartSocket(
    () =>
      new Promise<{ currency: "USD" | "SGD"; bars: TradingViewDailyBar[] }>(
        (resolve, reject) => {
          let ws: TradingViewWebSocketLike;
          try {
            ws = openSocket();
          } catch (error) {
            reject(
              error instanceof MarketDataError
                ? error
                : new MarketDataError(
                    "network",
                    "TradingView",
                    `Failed to open TradingView socket for "${params.symbol}".`,
                  ),
            );
            return;
          }

          const sessionId = `cs_${Math.random().toString(36).slice(2, 10)}`;
          const rawPoints: number[][] = [];
          let resolvedCurrency: "USD" | "SGD" = target.defaultCurrency;
          let resolvedTimezone: string = target.defaultTimezone;
          let settled = false;

          const finishError = (err: MarketDataError) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
              ws.close();
            } catch {
              // Ignore socket teardown errors.
            }
            reject(err);
          };

          const finishSuccess = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
              ws.close();
            } catch {
              // Ignore socket teardown errors.
            }

            const byDate = new Map<string, TradingViewDailyBar>();
            for (const tuple of rawPoints) {
              if (!Array.isArray(tuple) || tuple.length < 5) {
                continue;
              }
              const [ts, open, high, low, close, volume] = tuple;
              if (
                typeof ts !== "number" ||
                !Number.isFinite(ts) ||
                typeof close !== "number" ||
                !Number.isFinite(close) ||
                close < 0
              ) {
                continue;
              }
              const barDate = toIsoDateInExchangeTimezone(ts, resolvedTimezone);
              if (barDate < params.startDate || barDate > params.endDate) {
                continue;
              }

              const fmtOpt = (val: unknown): string | null =>
                typeof val === "number" && Number.isFinite(val)
                  ? toDecimalString(toDecimal(val).toDecimalPlaces(6), 6)
                  : null;
              const fmtVol = (val: unknown): string | null =>
                typeof val === "number" && Number.isFinite(val) && val >= 0
                  ? String(Math.round(val))
                  : null;

              byDate.set(barDate, {
                date: barDate,
                open: fmtOpt(open),
                high: fmtOpt(high),
                low: fmtOpt(low),
                close: toDecimalString(toDecimal(close).toDecimalPlaces(6), 6),
                volume: fmtVol(volume),
                source: "tradingview",
              });
            }

            const bars = [...byDate.values()].sort((a, b) =>
              a.date.localeCompare(b.date),
            );
            if (bars.length === 0) {
              reject(
                new MarketDataError(
                  "not_found",
                  "TradingView",
                  `No TradingView daily bars in requested window for "${params.symbol}".`,
                ),
              );
              return;
            }

            resolve({ currency: resolvedCurrency, bars });
          };

          const timer = setTimeout(() => {
            finishError(
              new MarketDataError(
                "network",
                "TradingView",
                `TradingView chart stream timed out for "${params.symbol}".`,
              ),
            );
          }, TV_WS_TIMEOUT_MS);

          ws.addEventListener("open", () => {
            try {
              ws.send(
                encodeTvSocketFrame({
                  m: "set_auth_token",
                  p: ["unauthorized_user_token"],
                }),
              );
              ws.send(
                encodeTvSocketFrame({
                  m: "chart_create_session",
                  p: [sessionId, ""],
                }),
              );
              ws.send(
                encodeTvSocketFrame({
                  m: "resolve_symbol",
                  p: [
                    sessionId,
                    "sds_sym_1",
                    `=${JSON.stringify({ adjustment: "splits", symbol: target.ticker })}`,
                  ],
                }),
              );
              ws.send(
                encodeTvSocketFrame({
                  m: "create_series",
                  p: [sessionId, "sds_1", "s1", "sds_sym_1", "1D", barsToRequest],
                }),
              );
            } catch {
              finishError(
                new MarketDataError(
                  "network",
                  "TradingView",
                  `Failed sending TradingView chart subscription for "${params.symbol}".`,
                ),
              );
            }
          });

          ws.addEventListener("error", () => {
            finishError(
              new MarketDataError(
                "network",
                "TradingView",
                `TradingView WebSocket connection error for "${params.symbol}".`,
              ),
            );
          });

          ws.addEventListener("message", (event) => {
            const rawText =
              typeof event.data === "string"
                ? event.data
                : String(event.data ?? "");
            for (const frameBody of parseTvSocketFrames(rawText)) {
              if (frameBody.startsWith("~h~")) {
                try {
                  ws.send(encodeTvSocketFrame(frameBody));
                } catch {
                  // Ignore heartbeat errors on closing sockets.
                }
                continue;
              }
              let parsed: { m?: string; p?: unknown[] };
              try {
                parsed = JSON.parse(frameBody) as { m?: string; p?: unknown[] };
              } catch {
                continue;
              }

              if (parsed.m === "symbol_resolved") {
                const info = parsed.p?.[2] as
                  | { timezone?: string; currency_code?: string }
                  | undefined;
                if (typeof info?.timezone === "string" && info.timezone.trim()) {
                  resolvedTimezone = info.timezone.trim();
                }
                const rawCur = (info?.currency_code ?? "").toUpperCase();
                if (rawCur === "USD" || rawCur === "SGD") {
                  resolvedCurrency = rawCur;
                }
              } else if (parsed.m === "timescale_update") {
                const updates = parsed.p?.[1] as
                  | { sds_1?: { s?: { v?: number[] }[] } }
                  | undefined;
                const seriesBars = updates?.sds_1?.s;
                if (Array.isArray(seriesBars)) {
                  for (const bar of seriesBars) {
                    if (Array.isArray(bar?.v)) {
                      rawPoints.push(bar.v);
                    }
                  }
                }
              } else if (parsed.m === "series_completed") {
                finishSuccess();
                return;
              } else if (parsed.m === "symbol_error") {
                finishError(
                  new MarketDataError(
                    "not_found",
                    "TradingView",
                    `TradingView symbol resolution failed for "${target.ticker}".`,
                  ),
                );
                return;
              }
            }
          });
        },
      ),
  );
}

