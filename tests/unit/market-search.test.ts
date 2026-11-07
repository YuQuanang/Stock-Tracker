import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarketDataError } from "@/lib/market-data/errors";
import {
  clearSymbolSearchCache,
  lookupExactSymbol,
  searchSymbols,
} from "@/lib/market-data/search";

describe("Step (a): live symbol and company name search", () => {
  beforeEach(() => {
    clearSymbolSearchCache();
  });

  it("canonicalizes US and SGX (.SI) matches, skips foreign/non-equity noise, and caches queries", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: "ok",
        data: [
          {
            symbol: "AAPL",
            instrument_name: "Apple Inc.",
            exchange: "NASDAQ",
            mic_code: "XNGS",
            country: "United States",
            currency: "USD",
            instrument_type: "Common Stock",
          },
          {
            symbol: "AAPL",
            instrument_name: "Apple Inc.",
            exchange: "BVC",
            mic_code: "XBOG",
            country: "Colombia",
            currency: "COP",
            instrument_type: "Common Stock",
          },
          {
            symbol: "ES3",
            instrument_name: "SPDR Straits Times Index ETF",
            exchange: "SGX",
            mic_code: "XSES",
            country: "Singapore",
            currency: "SGD",
            instrument_type: "ETF",
          },
        ],
      }),
    });

    const first = await searchSymbols("App", {
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(first).toEqual([
      {
        symbol: "AAPL",
        name: "Apple Inc.",
        exchangeCode: "NMS",
        exchangeDisplay: "NASDAQ",
        currency: "USD",
        quoteType: "EQUITY",
      },
      {
        symbol: "ES3.SI",
        name: "SPDR Straits Times Index ETF",
        exchangeCode: "SES",
        exchangeDisplay: "SGX",
        currency: "SGD",
        quoteType: "ETF",
      },
    ]);

    const cached = await searchSymbols("app", {
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(cached).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("resolves exact symbols case-insensitively (including .SI) and returns null on non-existent symbols", async () => {
    const mockFetch = vi
      .fn()
      // 1st call: Twelve Data search for ES3
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: "ok",
          data: [
            {
              symbol: "ES3",
              instrument_name: "SPDR Straits Times Index ETF",
              exchange: "SGX",
              mic_code: "XSES",
              country: "Singapore",
              currency: "SGD",
              instrument_type: "ETF",
            },
          ],
        }),
      })
      // 2nd call: Twelve Data search for BOGUS999 (empty)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "ok", data: [] }),
      })
      // 3rd call: Yahoo chart fallback for BOGUS999 (404)
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({}),
      });

    const exact = await lookupExactSymbol("es3.si", {
      fetchImpl: mockFetch as unknown as typeof fetch,
      skipCache: true,
    });
    expect(exact?.symbol).toBe("ES3.SI");
    expect(exact?.currency).toBe("SGD");

    const missing = await lookupExactSymbol("BOGUS999", {
      fetchImpl: mockFetch as unknown as typeof fetch,
      skipCache: true,
    });
    expect(missing).toBeNull();
  });

  it("falls back cleanly and classifies rate limits vs network errors when all providers fail", async () => {
    const rateLimitedFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({}),
    });

    await expect(
      searchSymbols("MSFT", {
        fetchImpl: rateLimitedFetch as unknown as typeof fetch,
        skipCache: true,
      }),
    ).rejects.toMatchObject({
      name: "MarketDataError",
      kind: "rate_limit",
    } satisfies Partial<MarketDataError>);

    const offlineFetch = vi
      .fn()
      .mockRejectedValue(new TypeError("fetch failed"));

    await expect(
      searchSymbols("MSFT", {
        fetchImpl: offlineFetch as unknown as typeof fetch,
        skipCache: true,
      }),
    ).rejects.toMatchObject({
      name: "MarketDataError",
      kind: "network",
    } satisfies Partial<MarketDataError>);
  });
});
