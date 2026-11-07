/**
 * Typed market-data provider errors so API routes and client components can
 * distinguish rate limiting (HTTP 429) from network timeouts and upstream
 * failures without leaking internal URLs or API keys.
 */

export type MarketDataErrorKind =
  | "rate_limit"
  | "not_found"
  | "network"
  | "upstream";

export class MarketDataError extends Error {
  public readonly kind: MarketDataErrorKind;
  public readonly provider: string;

  constructor(
    kind: MarketDataErrorKind,
    provider: string,
    message: string,
  ) {
    super(message);
    this.name = "MarketDataError";
    this.kind = kind;
    this.provider = provider;
  }

  get httpStatus(): number {
    switch (this.kind) {
      case "rate_limit":
        return 429;
      case "not_found":
        return 404;
      case "network":
      case "upstream":
        return 502;
    }
  }
}

export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

/** Executes an HTTP fetch with a timeout and classifies network/rate-limit errors. */
export async function fetchProviderJson<T>(params: {
  provider: string;
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<T> {
  const fetchFn = params.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    params.timeoutMs ?? 7000,
  );

  let response: Response;
  try {
    response = await fetchFn(params.url, {
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        ...params.headers,
      },
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (error) {
    clearTimeout(timeoutId);
    const isAbort = error instanceof Error && error.name === "AbortError";
    throw new MarketDataError(
      "network",
      params.provider,
      isAbort
        ? `${params.provider} timed out. Check your connection and try again.`
        : `Could not reach ${params.provider}. Check your internet connection.`,
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (response.status === 429) {
    throw new MarketDataError(
      "rate_limit",
      params.provider,
      "Market data rate limit reached. Please wait a few seconds and try again.",
    );
  }

  if (response.status === 404) {
    throw new MarketDataError(
      "not_found",
      params.provider,
      "Symbol was not found by the market data provider.",
    );
  }

  if (!response.ok) {
    throw new MarketDataError(
      "upstream",
      params.provider,
      `${params.provider} returned status ${response.status}.`,
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new MarketDataError(
      "upstream",
      params.provider,
      `${params.provider} returned an unreadable response.`,
    );
  }
}
