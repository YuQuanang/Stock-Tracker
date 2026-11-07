/**
 * Company & ETF Fundamentals / Key Statistics (`lib/market-data/fundamentals.ts`).
 *
 * Cached for 24 hours in memory (`TtlCache`).
 *
 * Strategy for free-tier reliability without paid API keys:
 *  1. Yahoo Finance `/v8/finance/chart/{symbol}?interval=1d&range=1y`:
 *     Reliably returns `fiftyTwoWeekHigh`, `fiftyTwoWeekLow` (or computes exact
 *     52-week high/low and 30-day average volume directly from the 1-year daily
 *     bars when meta omits them!), `currency`, `exchangeName`, and `longName`.
 *  2. Optional Finnhub enrichment (`/api/v1/stock/metric` & `/stock/profile2`)
 *     when `FINNHUB_API_KEY` is configured for US equities (`marketCap`, `peRatio`,
 *     `dividendYield`, `beta`, `sector` / `finnhubIndustry`).
 *  3. Any field not supplied by free providers is returned honestly as `null` —
 *     never guessed or fabricated.
 */
import { getEnv } from "@/lib/env";
import { toDecimal, toDecimalString } from "@/lib/finance/decimal";
import { TtlCache } from "@/lib/market-data/cache";
import { fetchProviderJson, MarketDataError } from "@/lib/market-data/errors";
import { inferMarketRegion } from "@/lib/market-data/hours";
import { inferInstrumentMetadata } from "@/lib/symbols";

export interface InstrumentFundamentals {
  symbol: string;
  name: string | null;
  currency: string;
  exchangeName: string | null;
  marketCap: string | null;
  peTrailing: string | null;
  /** Annualized dividend yield as a percentage string, e.g. `"3.42"` = 3.42%. */
  dividendYieldPercent: string | null;
  fiftyTwoWeekHigh: string | null;
  fiftyTwoWeekLow: string | null;
  beta: string | null;
  averageVolume: string | null;
  sector: string | null;
  industry: string | null;
  status: "ok" | "unavailable";
  asOf: string;
  source: string | null;
}

const FUNDAMENTALS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const fundamentalsCache = new TtlCache<InstrumentFundamentals>(250);

interface YahooYearChartResponse {
  chart?: {
    result?: {
      meta?: {
        symbol?: string;
        longName?: string;
        shortName?: string;
        currency?: string;
        exchangeName?: string;
        fiftyTwoWeekHigh?: number;
        fiftyTwoWeekLow?: number;
        regularMarketVolume?: number;
      };
      indicators?: {
        quote?: {
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }[];
      };
    }[];
  };
}

interface FinnhubMetricsResponse {
  metric?: {
    marketCapitalization?: number; // in millions of currency units
    peBasicExclExtraTTM?: number;
    peTTM?: number;
    dividendYieldIndicatedAnnual?: number;
    "52WeekHigh"?: number;
    "52WeekLow"?: number;
    beta?: number;
    "10DayAverageTradingVolume"?: number; // in millions of shares
  };
}

interface FinnhubProfileResponse {
  name?: string;
  finnhubIndustry?: string;
  marketCapitalization?: number;
}

function safePositiveDecimal(
  raw: number | null | undefined,
  decimals: number = 4,
): string | null {
  if (raw === null || raw === undefined || !Number.isFinite(raw) || raw <= 0) {
    return null;
  }
  return toDecimalString(toDecimal(raw).toDecimalPlaces(decimals), decimals);
}

function safeSignedDecimal(
  raw: number | null | undefined,
  decimals: number = 4,
): string | null {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) {
    return null;
  }
  return toDecimalString(toDecimal(raw).toDecimalPlaces(decimals), decimals);
}

export async function fetchInstrumentFundamentals(
  rawSymbol: string,
  options: {
    now?: Date;
    fetchImpl?: typeof fetch;
    skipCache?: boolean;
  } = {},
): Promise<InstrumentFundamentals> {
  const symbol = rawSymbol.trim();
  const now = options.now ?? new Date();
  const inferred = inferInstrumentMetadata({ symbol });

  if (!symbol || inferred.assetType === "crypto") {
    return {
      symbol,
      name: null,
      currency: inferred.currency,
      exchangeName: inferred.exchangeCode,
      marketCap: null,
      peTrailing: null,
      dividendYieldPercent: null,
      fiftyTwoWeekHigh: null,
      fiftyTwoWeekLow: null,
      beta: null,
      averageVolume: null,
      sector: null,
      industry: null,
      status: "unavailable",
      asOf: now.toISOString(),
      source: null,
    };
  }

  const cacheKey = symbol.toUpperCase();

  const execute = async (): Promise<InstrumentFundamentals> => {
    let name: string | null = null;
    let currency = inferred.currency;
    let exchangeName: string | null = inferred.exchangeCode;
    let fiftyTwoWeekHigh: string | null = null;
    let fiftyTwoWeekLow: string | null = null;
    let averageVolume: string | null = null;
    let marketCap: string | null = null;
    let peTrailing: string | null = null;
    let dividendYieldPercent: string | null = null;
    let beta: string | null = null;
    let sector: string | null = null;
    let industry: string | null = null;
    const sourcesUsed: string[] = [];

    // 1. Yahoo 1Y chart metadata + computed 52-week range & 30-day average volume
    try {
      const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
        symbol,
      )}?interval=1d&range=1y`;

      const chart = await fetchProviderJson<YahooYearChartResponse>({
        provider: "Yahoo Finance",
        url: yahooUrl,
        fetchImpl: options.fetchImpl,
      });

      const res = chart.chart?.result?.[0];
      const meta = res?.meta;
      const quote = res?.indicators?.quote?.[0];

      if (meta) {
        sourcesUsed.push("yahoo");
        name = meta.longName ?? meta.shortName ?? null;
        if (meta.currency) {
          currency = meta.currency.toUpperCase();
        }
        if (meta.exchangeName) {
          exchangeName = meta.exchangeName;
        }
        fiftyTwoWeekHigh = safePositiveDecimal(meta.fiftyTwoWeekHigh, 4);
        fiftyTwoWeekLow = safePositiveDecimal(meta.fiftyTwoWeekLow, 4);
      }

      if (quote) {
        const highs = (quote.high ?? []).filter(
          (v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0,
        );
        const lows = (quote.low ?? []).filter(
          (v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0,
        );
        const closes = (quote.close ?? []).filter(
          (v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0,
        );
        const volumes = (quote.volume ?? []).filter(
          (v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0,
        );

        if (!fiftyTwoWeekHigh && (highs.length > 0 || closes.length > 0)) {
          const maxVal = Math.max(...(highs.length > 0 ? highs : closes));
          fiftyTwoWeekHigh = safePositiveDecimal(maxVal, 4);
        }
        if (!fiftyTwoWeekLow && (lows.length > 0 || closes.length > 0)) {
          const minVal = Math.min(...(lows.length > 0 ? lows : closes));
          fiftyTwoWeekLow = safePositiveDecimal(minVal, 4);
        }
        if (volumes.length > 0) {
          const recent30 = volumes.slice(-30);
          const sum = recent30.reduce((acc, v) => acc + v, 0);
          averageVolume = toDecimalString(
            toDecimal(Math.round(sum / recent30.length)),
            0,
          );
        }
      }
    } catch (error) {
      if (error instanceof MarketDataError && error.kind === "not_found") {
        // Continue to Finnhub check if configured
      }
    }

    // 2. Optional Finnhub fundamentals enrichment for US equities when key is set
    const region = inferMarketRegion(symbol, exchangeName);
    let finnhubKey: string | undefined;
    try {
      finnhubKey = getEnv().FINNHUB_API_KEY;
    } catch {
      finnhubKey = process.env.FINNHUB_API_KEY;
    }

    if (region === "US" && !symbol.startsWith("^") && finnhubKey) {
      const apiKey = finnhubKey;
      const [metricsResult, profileResult] = await Promise.allSettled([
        fetchProviderJson<FinnhubMetricsResponse>({
          provider: "Finnhub",
          url: `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(
            symbol,
          )}&metric=all`,
          headers: { "X-Finnhub-Token": apiKey },
          fetchImpl: options.fetchImpl,
        }),
        fetchProviderJson<FinnhubProfileResponse>({
          provider: "Finnhub",
          url: `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(
            symbol,
          )}`,
          headers: { "X-Finnhub-Token": apiKey },
          fetchImpl: options.fetchImpl,
        }),
      ]);

      if (metricsResult.status === "fulfilled" && metricsResult.value.metric) {
        const m = metricsResult.value.metric;
        sourcesUsed.push("finnhub");

        if (typeof m.marketCapitalization === "number" && m.marketCapitalization > 0) {
          // Finnhub reports marketCapitalization in millions
          marketCap = toDecimalString(
            toDecimal(m.marketCapitalization).mul(1_000_000).toDecimalPlaces(0),
            0,
          );
        }
        peTrailing = safePositiveDecimal(m.peBasicExclExtraTTM ?? m.peTTM, 2);
        dividendYieldPercent = safePositiveDecimal(
          m.dividendYieldIndicatedAnnual,
          2,
        );
        beta = safeSignedDecimal(m.beta, 2);

        if (!fiftyTwoWeekHigh) {
          fiftyTwoWeekHigh = safePositiveDecimal(m["52WeekHigh"], 4);
        }
        if (!fiftyTwoWeekLow) {
          fiftyTwoWeekLow = safePositiveDecimal(m["52WeekLow"], 4);
        }
        if (
          !averageVolume &&
          typeof m["10DayAverageTradingVolume"] === "number" &&
          m["10DayAverageTradingVolume"] > 0
        ) {
          averageVolume = toDecimalString(
            toDecimal(m["10DayAverageTradingVolume"])
              .mul(1_000_000)
              .toDecimalPlaces(0),
            0,
          );
        }
      }

      if (profileResult.status === "fulfilled" && profileResult.value) {
        const p = profileResult.value;
        if (!name && p.name) {
          name = p.name;
        }
        if (p.finnhubIndustry) {
          industry = p.finnhubIndustry;
          sector = p.finnhubIndustry;
        }
      }
    }

    if (sourcesUsed.length === 0) {
      return {
        symbol,
        name: null,
        currency,
        exchangeName,
        marketCap: null,
        peTrailing: null,
        dividendYieldPercent: null,
        fiftyTwoWeekHigh: null,
        fiftyTwoWeekLow: null,
        beta: null,
        averageVolume: null,
        sector: null,
        industry: null,
        status: "unavailable",
        asOf: now.toISOString(),
        source: null,
      };
    }

    return {
      symbol,
      name,
      currency,
      exchangeName,
      marketCap,
      peTrailing,
      dividendYieldPercent,
      fiftyTwoWeekHigh,
      fiftyTwoWeekLow,
      beta,
      averageVolume,
      sector,
      industry,
      status: "ok",
      asOf: now.toISOString(),
      source: [...new Set(sourcesUsed)].join("+"),
    };
  };

  return options.skipCache
    ? execute()
    : fundamentalsCache.getOrFetch(cacheKey, FUNDAMENTALS_TTL_MS, execute);
}

export function clearFundamentalsCache(): void {
  fundamentalsCache.clear();
}

