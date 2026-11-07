/**
 * Client-side helpers for the New Transaction autocomplete and auto-fill
 * endpoints (`/api/market/search`, `/api/market/quote`, `/api/market/fx`).
 *
 * Responsibilities:
 *  - Maintain a bounded in-memory query cache on the client so repeated or
 *    backspaced searches return immediately without redundant API calls.
 *  - Classify HTTP 429 rate-limit responses, offline/network errors, 404 exact
 *    lookup misses, and upstream provider errors into clear human sentences.
 *  - Support `AbortSignal` cancellation so outdated responses are discarded.
 */
import type { ExchangeRateSnapshot } from "@/lib/market-data/fx";
import type { StockPriceQuote } from "@/lib/market-data/quotes";
import type { SymbolSearchMatch } from "@/lib/market-data/search";

export type ClientMarketErrorKind =
  | "rate_limit"
  | "network"
  | "not_found"
  | "upstream";

export class ClientMarketError extends Error {
  public readonly kind: ClientMarketErrorKind;

  constructor(kind: ClientMarketErrorKind, message: string) {
    super(message);
    this.name = "ClientMarketError";
    this.kind = kind;
  }
}

interface CachedSearchEntry {
  matches: SymbolSearchMatch[];
  expiresAt: number;
}

const CLIENT_SEARCH_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CLIENT_SEARCH_MAX_ENTRIES = 100;
const clientSearchCache = new Map<string, CachedSearchEntry>();

export function clearClientSearchCache(): void {
  clientSearchCache.clear();
}

function normalizeSearchKey(query: string): string {
  return query.trim().toLowerCase();
}

function readCachedSuggestions(query: string): SymbolSearchMatch[] | null {
  const key = normalizeSearchKey(query);
  const entry = clientSearchCache.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    clientSearchCache.delete(key);
    return null;
  }
  // Refresh LRU insertion order
  clientSearchCache.delete(key);
  clientSearchCache.set(key, entry);
  return entry.matches;
}

function writeCachedSuggestions(
  query: string,
  matches: SymbolSearchMatch[],
): void {
  const key = normalizeSearchKey(query);
  if (clientSearchCache.has(key)) {
    clientSearchCache.delete(key);
  } else if (clientSearchCache.size >= CLIENT_SEARCH_MAX_ENTRIES) {
    const oldestKey = clientSearchCache.keys().next().value;
    if (oldestKey !== undefined) {
      clientSearchCache.delete(oldestKey);
    }
  }
  clientSearchCache.set(key, {
    matches,
    expiresAt: Date.now() + CLIENT_SEARCH_TTL_MS,
  });
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

interface ApiErrorPayload {
  error?: string;
  kind?: string;
}

async function parseErrorResponse(
  response: Response,
  fallbackMessages: {
    rateLimit: string;
    notFound: string;
    upstream: string;
  },
): Promise<ClientMarketError> {
  const payload = (await response.json().catch(() => null)) as
    | ApiErrorPayload
    | null;

  if (response.status === 429 || payload?.kind === "rate_limit") {
    return new ClientMarketError(
      "rate_limit",
      payload?.error ?? fallbackMessages.rateLimit,
    );
  }

  if (response.status === 404 || payload?.kind === "not_found") {
    return new ClientMarketError(
      "not_found",
      payload?.error ?? fallbackMessages.notFound,
    );
  }

  if (payload?.kind === "network") {
    return new ClientMarketError(
      "network",
      payload.error ??
        "Network error reaching market data provider. Check your connection.",
    );
  }

  return new ClientMarketError(
    "upstream",
    payload?.error ?? fallbackMessages.upstream,
  );
}

/**
 * Fetches live symbol/company-name suggestions, checking the in-memory client
 * cache first.
 */
export async function searchStocksClient(
  query: string,
  options: {
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<SymbolSearchMatch[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const cached = readCachedSuggestions(trimmed);
  if (cached !== null) {
    return cached;
  }

  const fetcher = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetcher(
      `/api/market/search?q=${encodeURIComponent(trimmed)}`,
      {
        method: "GET",
        signal: options.signal,
      },
    );
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new ClientMarketError(
      "network",
      "Network error while searching stocks. Check your internet connection.",
    );
  }

  if (!response.ok) {
    throw await parseErrorResponse(response, {
      rateLimit:
        "Symbol search rate limit reached. Wait a few seconds and try again.",
      notFound: `No matching stocks found for "${trimmed}".`,
      upstream: "Symbol search is temporarily unavailable. Try again shortly.",
    });
  }

  const body = (await response.json()) as { matches?: SymbolSearchMatch[] };
  const matches = body.matches ?? [];
  writeCachedSuggestions(trimmed, matches);
  return matches;
}

/**
 * Verifies an exact ticker symbol when the user leaves the Symbol field without
 * picking from the dropdown (Requirement 10).
 */
export async function lookupExactSymbolClient(
  symbol: string,
  options: {
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<SymbolSearchMatch> {
  const trimmed = symbol.trim();
  const fetcher = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetcher(
      `/api/market/search?q=${encodeURIComponent(trimmed)}&exact=1`,
      {
        method: "GET",
        signal: options.signal,
      },
    );
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new ClientMarketError(
      "network",
      "Could not verify symbol because of a network error.",
    );
  }

  if (!response.ok) {
    throw await parseErrorResponse(response, {
      rateLimit:
        "Rate limit reached while verifying symbol. Wait a moment and retry.",
      notFound: `No stock or ETF found with exact ticker "${trimmed.toUpperCase()}".`,
      upstream: "Could not verify ticker right now.",
    });
  }

  const body = (await response.json()) as { match?: SymbolSearchMatch | null };
  if (!body.match) {
    throw new ClientMarketError(
      "not_found",
      `No stock or ETF found with exact ticker "${trimmed.toUpperCase()}".`,
    );
  }
  return body.match;
}

/**
 * Fetches either the latest market quote (when `date >= todaySgtDate`) or the
 * historical close on `date` (when backdated, `date < todaySgtDate`).
 */
export async function fetchStockPriceClient(
  symbol: string,
  date: string,
  todaySgtDate: string,
  options: {
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<StockPriceQuote> {
  const fetcher = options.fetchImpl ?? fetch;
  const isBackdated = /^\d{4}-\d{2}-\d{2}$/.test(date) && date < todaySgtDate;

  const params = new URLSearchParams({ symbol: symbol.trim() });
  if (isBackdated) {
    params.set("date", date);
  }

  let response: Response;
  try {
    response = await fetcher(`/api/market/quote?${params.toString()}`, {
      method: "GET",
      signal: options.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new ClientMarketError(
      "network",
      "Could not load price (network error). Enter a price manually.",
    );
  }

  if (!response.ok) {
    throw await parseErrorResponse(response, {
      rateLimit:
        "Price provider rate limit reached. Enter the price manually or retry shortly.",
      notFound: isBackdated
        ? `No historical price found for ${symbol} on ${date}. Enter the price manually.`
        : `Price unavailable for ${symbol}. Enter the price manually.`,
      upstream: "Could not fetch price. You can enter it manually.",
    });
  }

  const body = (await response.json()) as { quote?: StockPriceQuote };
  if (!body.quote) {
    throw new ClientMarketError(
      "upstream",
      "Price response was empty. Enter the price manually.",
    );
  }
  return body.quote;
}

/**
 * Fetches the USD -> SGD exchange rate (latest or historical when backdated).
 */
export async function fetchUsdToSgdClient(
  date: string,
  todaySgtDate: string,
  options: {
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<ExchangeRateSnapshot> {
  const fetcher = options.fetchImpl ?? fetch;
  const isBackdated = /^\d{4}-\d{2}-\d{2}$/.test(date) && date < todaySgtDate;

  const params = new URLSearchParams({ from: "USD" });
  if (isBackdated) {
    params.set("date", date);
  }

  let response: Response;
  try {
    response = await fetcher(`/api/market/fx?${params.toString()}`, {
      method: "GET",
      signal: options.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new ClientMarketError(
      "network",
      "Could not load USD/SGD rate (network error). Enter a rate manually.",
    );
  }

  if (!response.ok) {
    throw await parseErrorResponse(response, {
      rateLimit:
        "FX provider rate limit reached. Enter a USD/SGD rate manually.",
      notFound: isBackdated
        ? `No historical USD/SGD rate found for ${date}. Enter a rate manually.`
        : "USD/SGD rate unavailable. Enter a rate manually.",
      upstream: "Could not fetch USD/SGD rate. You can enter it manually.",
    });
  }

  const body = (await response.json()) as { fx?: ExchangeRateSnapshot };
  if (!body.fx) {
    throw new ClientMarketError(
      "upstream",
      "FX response was empty. Enter a USD/SGD rate manually.",
    );
  }
  return body.fx;
}

