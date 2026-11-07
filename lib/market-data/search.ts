/**
 * Live symbol and company-name search (server-side only).
 *
 * Provider chain for search metadata (never hardcoded/bundled tickers):
 *   1. Twelve Data `/symbol_search` (free public metadata endpoint; used ONLY
 *      for symbol/company-name lookup, never for displayed prices per license).
 *   2. Finnhub `/search` when `FINNHUB_API_KEY` is configured.
 *   3. Yahoo Finance `/v1/finance/search`.
 *
 * Supports both US exchanges (`NASDAQ`, `NYSE`, `NYSE Arca`, `NYSE American`,
 * `OTC`) in `USD` and Singapore Exchange (`SGX`) in `SGD` (canonicalized to
 * Yahoo-style `.SI` suffixes such as `ES3.SI` and `A17U.SI`).
 */
import { getEnv } from "@/lib/env";
import { TtlCache } from "@/lib/market-data/cache";
import { fetchProviderJson, MarketDataError } from "@/lib/market-data/errors";

export interface SymbolSearchMatch {
  symbol: string;
  name: string;
  /** Short exchange code matching CSV conventions (`NMS`, `NYQ`, `PCX`, `SES`). */
  exchangeCode: string;
  /** Human-friendly exchange label (`NASDAQ`, `NYSE`, `NYSE Arca`, `SGX`). */
  exchangeDisplay: string;
  /** Trading currency (`USD` or `SGD`). */
  currency: "USD" | "SGD";
  quoteType: "EQUITY" | "ETF" | "INDEX";
}

const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const searchCache = new TtlCache<SymbolSearchMatch[]>(300);

interface TwelveDataSearchResponse {
  status?: string;
  code?: number;
  message?: string;
  data?: {
    symbol?: string;
    instrument_name?: string;
    exchange?: string;
    mic_code?: string;
    country?: string;
    currency?: string;
    instrument_type?: string;
  }[];
}

interface YahooSearchResponse {
  quotes?: {
    symbol?: string;
    shortname?: string;
    longname?: string;
    exchange?: string;
    exchDisp?: string;
    quoteType?: string;
  }[];
}

interface YahooChartMetaResponse {
  chart?: {
    result?: {
      meta?: {
        symbol?: string;
        longName?: string;
        shortName?: string;
        exchangeName?: string;
        fullExchangeName?: string;
        currency?: string;
        instrumentType?: string;
      };
    }[];
  };
}

interface FinnhubSearchResponse {
  result?: {
    symbol?: string;
    description?: string;
    type?: string;
  }[];
}

const US_EXCHANGE_CODES = new Set([
  "NMS",
  "NGM",
  "NCM",
  "NASDAQ",
  "NYQ",
  "NYSE",
  "PCX",
  "ARCX",
  "ASE",
  "AMEX",
  "BTS",
  "BATS",
  "PNK",
  "OTC",
]);

const EXCHANGE_DISPLAY_NAMES: Record<string, string> = {
  NMS: "NASDAQ",
  NGM: "NASDAQ",
  NCM: "NASDAQ",
  NASDAQ: "NASDAQ",
  NYQ: "NYSE",
  NYSE: "NYSE",
  PCX: "NYSE Arca",
  ARCX: "NYSE Arca",
  ASE: "NYSE American",
  AMEX: "NYSE American",
  BTS: "Cboe BZX",
  BATS: "Cboe BZX",
  PNK: "OTC",
  OTC: "OTC",
  SES: "SGX",
  SGX: "SGX",
};

function mapTwelveDataRow(row: {
  symbol?: string;
  instrument_name?: string;
  exchange?: string;
  mic_code?: string;
  country?: string;
  currency?: string;
  instrument_type?: string;
}): SymbolSearchMatch | null {
  const rawSymbol = (row.symbol ?? "").trim();
  const name = (row.instrument_name ?? "").trim();
  const exchangeUpper = (row.exchange ?? "").trim().toUpperCase();
  const country = (row.country ?? "").trim();
  const currency = (row.currency ?? "").trim().toUpperCase();
  const typeLower = (row.instrument_type ?? "").trim().toLowerCase();

  if (!rawSymbol || !name) {
    return null;
  }

  // Keep equities, ETFs, REITs, ADRs, and trusts; skip crypto/forex/futures.
  const isStockOrFund =
    typeLower.includes("stock") ||
    typeLower.includes("etf") ||
    typeLower.includes("reit") ||
    typeLower.includes("depositary") ||
    typeLower.includes("trust") ||
    typeLower.includes("fund");
  if (!isStockOrFund) {
    return null;
  }

  const quoteType: "EQUITY" | "ETF" = typeLower.includes("etf")
    ? "ETF"
    : "EQUITY";

  // Singapore Exchange -> canonicalize to `.SI` and `SES`
  if (
    exchangeUpper === "SGX" ||
    row.mic_code === "XSES" ||
    country === "Singapore"
  ) {
    if (currency !== "SGD" && currency !== "USD") {
      return null;
    }
    const normalizedSymbol = rawSymbol.toUpperCase().endsWith(".SI")
      ? rawSymbol.toUpperCase()
      : `${rawSymbol.toUpperCase()}.SI`;
    return {
      symbol: normalizedSymbol,
      name,
      exchangeCode: "SES",
      exchangeDisplay: "SGX",
      currency: currency === "USD" ? "USD" : "SGD",
      quoteType,
    };
  }

  // United States exchanges in USD
  if (country === "United States" && currency === "USD") {
    let exchangeCode = "NMS";
    let exchangeDisplay = row.exchange ?? "US Exchange";

    if (exchangeUpper === "NASDAQ") {
      exchangeCode = "NMS";
      exchangeDisplay = "NASDAQ";
    } else if (exchangeUpper === "NYSE") {
      exchangeCode = "NYQ";
      exchangeDisplay = "NYSE";
    } else if (exchangeUpper.includes("ARCA") || row.mic_code === "ARCX") {
      exchangeCode = "PCX";
      exchangeDisplay = "NYSE Arca";
    } else if (exchangeUpper.includes("AMEX") || row.mic_code === "XASE") {
      exchangeCode = "ASE";
      exchangeDisplay = "NYSE American";
    } else if (exchangeUpper === "OTC" || (row.mic_code ?? "").startsWith("PIN")) {
      exchangeCode = "PNK";
      exchangeDisplay = "OTC";
    }

    // Canonicalize share classes such as BRK/B -> BRK-B for Yahoo compatibility
    const normalizedSymbol = rawSymbol.replace("/", "-");

    return {
      symbol: normalizedSymbol,
      name,
      exchangeCode,
      exchangeDisplay,
      currency: "USD",
      quoteType,
    };
  }

  return null;
}

async function searchViaTwelveData(
  query: string,
  fetchImpl?: typeof fetch,
): Promise<SymbolSearchMatch[]> {
  // Strip `.SI` suffix when querying Twelve Data because it indexes SGX tickers
  // by base code (e.g. `ES3`, `A17U`), then re-attaches `.SI` in `mapTwelveDataRow`.
  const normalizedQuery = query.toUpperCase().endsWith(".SI")
    ? query.slice(0, -3)
    : query;

  const url = `https://api.twelvedata.com/symbol_search?symbol=${encodeURIComponent(
    normalizedQuery,
  )}&outputsize=30`;

  const payload = await fetchProviderJson<TwelveDataSearchResponse>({
    provider: "Twelve Data",
    url,
    fetchImpl,
  });

  if (payload.code === 429) {
    throw new MarketDataError(
      "rate_limit",
      "Twelve Data",
      "Symbol search rate limit reached. Please wait a moment and try again.",
    );
  }
  if (payload.status === "error") {
    throw new MarketDataError(
      "upstream",
      "Twelve Data",
      payload.message ?? "Symbol search returned an error.",
    );
  }

  const results: SymbolSearchMatch[] = [];
  const seen = new Set<string>();
  const wantSgxOnly = query.toUpperCase().endsWith(".SI");

  for (const item of payload.data ?? []) {
    const mapped = mapTwelveDataRow(item);
    if (!mapped || seen.has(mapped.symbol)) {
      continue;
    }
    if (wantSgxOnly && mapped.exchangeCode !== "SES") {
      continue;
    }
    seen.add(mapped.symbol);
    results.push(mapped);
  }

  // Prioritize primary exchange listings over OTC when searching by name.
  results.sort((a, b) => {
    const aOtc = a.exchangeCode === "PNK" ? 1 : 0;
    const bOtc = b.exchangeCode === "PNK" ? 1 : 0;
    return aOtc - bOtc;
  });

  return results;
}

async function searchViaYahoo(
  query: string,
  allowIndices: boolean,
  fetchImpl?: typeof fetch,
): Promise<SymbolSearchMatch[]> {
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
    query,
  )}&quotesCount=15&newsCount=0&enableFuzzyQuery=false`;

  const payload = await fetchProviderJson<YahooSearchResponse>({
    provider: "Yahoo Finance",
    url,
    fetchImpl,
  });

  const results: SymbolSearchMatch[] = [];
  const seen = new Set<string>();

  for (const item of payload.quotes ?? []) {
    const symbol = item.symbol?.trim();
    const officialName = (item.longname ?? item.shortname ?? "").trim();
    const rawType = (item.quoteType ?? "").toUpperCase();
    const rawExch = (item.exchange ?? "").toUpperCase();

    if (!symbol || !officialName || seen.has(symbol)) {
      continue;
    }

    const isAllowedType =
      rawType === "EQUITY" ||
      rawType === "ETF" ||
      (allowIndices && rawType === "INDEX");
    if (!isAllowedType) {
      continue;
    }

    const isSgx =
      symbol.toUpperCase().endsWith(".SI") ||
      rawExch === "SES" ||
      rawExch === "SGX";
    const isUs = US_EXCHANGE_CODES.has(rawExch);
    if (!isSgx && !isUs) {
      continue;
    }

    seen.add(symbol);
    results.push({
      symbol,
      name: officialName,
      exchangeCode: isSgx ? "SES" : rawExch,
      exchangeDisplay: isSgx
        ? "SGX"
        : (EXCHANGE_DISPLAY_NAMES[rawExch] ?? (item.exchDisp || rawExch)),
      currency: isSgx ? "SGD" : "USD",
      quoteType: rawType as "EQUITY" | "ETF" | "INDEX",
    });
  }

  return results;
}

async function searchViaFinnhub(
  query: string,
  apiKey: string,
  fetchImpl?: typeof fetch,
): Promise<SymbolSearchMatch[]> {
  const url = `https://finnhub.io/api/v1/search?q=${encodeURIComponent(query)}`;
  const payload = await fetchProviderJson<FinnhubSearchResponse>({
    provider: "Finnhub",
    url,
    headers: { "X-Finnhub-Token": apiKey },
    fetchImpl,
  });

  const results: SymbolSearchMatch[] = [];
  const seen = new Set<string>();

  for (const item of payload.result ?? []) {
    const symbol = (item.symbol ?? "").trim();
    const name = (item.description ?? "").trim();
    const type = (item.type ?? "").toUpperCase();
    if (!symbol || !name || seen.has(symbol)) {
      continue;
    }

    const isSgx = symbol.toUpperCase().endsWith(".SI");
    const isUsPlain = !symbol.includes(".") || /\.[AB]$/.test(symbol);
    if (!isSgx && !isUsPlain) {
      continue;
    }

    seen.add(symbol);
    results.push({
      symbol,
      name,
      exchangeCode: isSgx ? "SES" : "NMS",
      exchangeDisplay: isSgx ? "SGX" : "US Exchange",
      currency: isSgx ? "SGD" : "USD",
      quoteType: type.includes("ETF") ? "ETF" : "EQUITY",
    });
  }

  return results;
}

/**
 * Verifies an exact symbol directly against Yahoo's chart metadata endpoint
 * (`/v8/finance/chart/{symbol}`) when the text search returned no exact match.
 */
async function verifyExactViaYahooChart(
  symbol: string,
  fetchImpl?: typeof fetch,
): Promise<SymbolSearchMatch | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?interval=1d&range=2d`;

  try {
    const payload = await fetchProviderJson<YahooChartMetaResponse>({
      provider: "Yahoo Finance",
      url,
      fetchImpl,
    });
    const meta = payload.chart?.result?.[0]?.meta;
    if (!meta?.symbol) {
      return null;
    }
    const currencyUpper = (meta.currency ?? "").toUpperCase();
    if (currencyUpper !== "USD" && currencyUpper !== "SGD") {
      return null;
    }
    const name = (meta.longName ?? meta.shortName ?? "").trim();
    if (!name) {
      return null;
    }
    const rawExch = (meta.exchangeName ?? "").toUpperCase();
    const isSgx =
      meta.symbol.toUpperCase().endsWith(".SI") ||
      rawExch === "SES" ||
      currencyUpper === "SGD";
    const instType = (meta.instrumentType ?? "").toUpperCase();

    return {
      symbol: meta.symbol,
      name,
      exchangeCode: isSgx ? "SES" : rawExch || "NMS",
      exchangeDisplay: isSgx
        ? "SGX"
        : (EXCHANGE_DISPLAY_NAMES[rawExch] ??
            (meta.fullExchangeName || rawExch || "US Exchange")),
      currency: currencyUpper,
      quoteType: instType === "ETF" ? "ETF" : "EQUITY",
    };
  } catch (error) {
    if (error instanceof MarketDataError && error.kind === "not_found") {
      return null;
    }
    return null;
  }
}

export interface SearchSymbolsOptions {
  limit?: number;
  allowIndices?: boolean;
  fetchImpl?: typeof fetch;
  skipCache?: boolean;
}

/**
 * Searches live market providers for stocks and ETFs matching `query` by
 * ticker or company name.
 */
export async function searchSymbols(
  rawQuery: string,
  options: SearchSymbolsOptions = {},
): Promise<SymbolSearchMatch[]> {
  const query = rawQuery.trim();
  if (query.length === 0) {
    return [];
  }

  const limit = options.limit ?? 8;
  const allowIndices = options.allowIndices ?? query.startsWith("^");
  const cacheKey = `${query.toLowerCase()}|${allowIndices ? "idx" : "eq"}`;

  const executeSearch = async (): Promise<SymbolSearchMatch[]> => {
    let firstError: unknown = null;

    try {
      const primary = await searchViaTwelveData(query, options.fetchImpl);
      if (primary.length > 0 || !allowIndices) {
        return primary;
      }
    } catch (error) {
      firstError = error;
    }

    let finnhubKey: string | undefined;
    try {
      finnhubKey = getEnv().FINNHUB_API_KEY;
    } catch {
      finnhubKey = process.env.FINNHUB_API_KEY;
    }

    if (finnhubKey) {
      try {
        return await searchViaFinnhub(query, finnhubKey, options.fetchImpl);
      } catch (error) {
        firstError = firstError ?? error;
      }
    }

    try {
      return await searchViaYahoo(query, allowIndices, options.fetchImpl);
    } catch (error) {
      firstError = firstError ?? error;
    }

    if (firstError instanceof MarketDataError) {
      throw firstError;
    }
    throw new MarketDataError(
      "upstream",
      "Symbol Search",
      "Symbol search is temporarily unavailable.",
    );
  };

  const fullList = options.skipCache
    ? await executeSearch()
    : await searchCache.getOrFetch(cacheKey, SEARCH_CACHE_TTL_MS, executeSearch);

  return fullList.slice(0, limit);
}

/**
 * Resolves an exact ticker symbol (case-insensitive, e.g. `"aapl"` -> `"AAPL"`,
 * `"es3.si"` -> `"ES3.SI"`). Returns `null` when no exact match exists so the
 * form rejects unverified symbols instead of silently accepting them.
 */
export async function lookupExactSymbol(
  rawSymbol: string,
  options: SearchSymbolsOptions = {},
): Promise<SymbolSearchMatch | null> {
  const needle = rawSymbol.trim().toUpperCase();
  if (!needle) {
    return null;
  }

  let searchError: unknown = null;
  try {
    const candidates = await searchSymbols(needle, {
      ...options,
      limit: 20,
      allowIndices: needle.startsWith("^"),
    });
    const exact = candidates.find(
      (candidate) => candidate.symbol.toUpperCase() === needle,
    );
    if (exact) {
      return exact;
    }
  } catch (error) {
    searchError = error;
  }

  // Fallback to direct Yahoo chart metadata verification for exact tickers.
  const chartVerified = await verifyExactViaYahooChart(
    needle,
    options.fetchImpl,
  );
  if (chartVerified) {
    return chartVerified;
  }

  if (searchError instanceof MarketDataError) {
    throw searchError;
  }
  return null;
}

export function clearSymbolSearchCache(): void {
  searchCache.clear();
}
