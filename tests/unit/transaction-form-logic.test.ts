import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearClientSearchCache,
  ClientMarketError,
  fetchStockPriceClient,
  fetchUsdToSgdClient,
  lookupExactSymbolClient,
  searchStocksClient,
} from "@/lib/transactions/client-market-api";
import {
  applyCompanyNameInputEdit,
  applyManualFxRateEdit,
  applyManualPriceEdit,
  applyStockSelection,
  applySymbolInputEdit,
  clearAutoFilledForDateChange,
  computeTransactionSgdTotal,
  createInitialLinkedStockState,
  createLinkedStockStateFromExisting,
} from "@/lib/transactions/form-logic";

describe("Step (d): transaction form two-way linking, backdating, and SGD math", () => {
  const appleMatch = {
    symbol: "AAPL",
    name: "Apple Inc.",
    exchangeCode: "NMS",
    exchangeDisplay: "NASDAQ",
    currency: "USD" as const,
    quoteType: "EQUITY" as const,
  };

  const sgxMatch = {
    symbol: "ES3.SI",
    name: "SPDR Straits Times Index ETF",
    exchangeCode: "SES",
    exchangeDisplay: "SGX",
    currency: "SGD" as const,
    quoteType: "ETF" as const,
  };

  it("fills both symbol and company name on selection, and sets rate=1 for SGD stocks", () => {
    const initial = createInitialLinkedStockState();
    const usdSelected = applyStockSelection(initial, appleMatch);
    expect(usdSelected.symbol).toBe("AAPL");
    expect(usdSelected.instrumentName).toBe("Apple Inc.");
    expect(usdSelected.exchangeDisplay).toBe("NASDAQ");
    expect(usdSelected.currency).toBe("USD");
    expect(usdSelected.selectionState).toBe("verified");
    expect(usdSelected.fxRateToSgd).toBe("");

    const sgdSelected = applyStockSelection(initial, sgxMatch);
    expect(sgdSelected.symbol).toBe("ES3.SI");
    expect(sgdSelected.currency).toBe("SGD");
    expect(sgdSelected.fxRateToSgd).toBe("1");
    expect(sgdSelected.fxSource).toBe("native-sgd");
  });

  it("clears partner field and auto-filled price/FX when either Symbol or Company Name is edited after selection", () => {
    let state = applyStockSelection(createInitialLinkedStockState(), appleMatch);
    state = {
      ...state,
      price: "342.37",
      priceStatus: "last_close",
      fxRateToSgd: "1.2816",
      fxSource: "frankfurter",
    };

    // Edit symbol -> company name and auto-filled price/FX must clear
    const afterSymbolEdit = applySymbolInputEdit(state, "AAP");
    expect(afterSymbolEdit.symbol).toBe("AAP");
    expect(afterSymbolEdit.instrumentName).toBe("");
    expect(afterSymbolEdit.price).toBe("");
    expect(afterSymbolEdit.fxRateToSgd).toBe("");
    expect(afterSymbolEdit.selectionState).toBe("unverified");

    // Edit company name -> symbol and auto-filled price/FX must clear
    const afterNameEdit = applyCompanyNameInputEdit(state, "Microsoft");
    expect(afterNameEdit.instrumentName).toBe("Microsoft");
    expect(afterNameEdit.symbol).toBe("");
    expect(afterNameEdit.price).toBe("");
    expect(afterNameEdit.fxRateToSgd).toBe("");
    expect(afterNameEdit.selectionState).toBe("unverified");
  });

  it("flags manual price and manual FX rate edits", () => {
    let state = applyStockSelection(createInitialLinkedStockState(), appleMatch);
    state = applyManualPriceEdit(state, "340.50");
    expect(state.isManualPrice).toBe(true);
    expect(state.priceStatus).toBe("manual");

    state = applyManualFxRateEdit(state, "1.3000");
    expect(state.isManualFxRate).toBe(true);
    expect(state.fxSource).toBe("manual");
    expect(state.fxLabel).toBe("Manual rate");
  });

  it("clears stale auto-filled price and FX immediately when backdating", () => {
    const autoState = {
      ...applyStockSelection(createInitialLinkedStockState(), appleMatch),
      price: "342.37",
      priceAsOf: "2026-11-06T21:00:00.000Z",
      priceStatus: "last_close",
      priceFreshnessLabel: "Last close, 6 Nov",
      fxRateToSgd: "1.2816",
      fxAsOf: "2026-11-07T04:00:00.000Z",
      fxSource: "frankfurter",
      fxLabel: "ECB rate, 6 Nov",
    };

    const reset = clearAutoFilledForDateChange(autoState, "2021-11-03");
    expect(reset.price).toBe("");
    expect(reset.priceFreshnessLabel).toBeNull();
    expect(reset.fxRateToSgd).toBe("");
    expect(reset.fxLabel).toBeNull();
  });

  it("computes SGD total cost with exact Decimal precision (never float drift)", () => {
    // In IEEE-754 float: 0.1 * 0.2 * 1.35 = 0.027000000000000003
    const exact = computeTransactionSgdTotal({
      type: "Buy",
      quantity: "0.1",
      price: "0.2",
      fxRateToSgd: "1.35",
    });
    expect(exact).toEqual({
      nativeGross: "0.02",
      totalSgd: "0.027",
    });

    // 5 shares * $342.37 * 1.2816 = 2193.90696 -> rounded 4dp = 2193.907
    const appleTotal = computeTransactionSgdTotal({
      type: "Buy",
      quantity: "5",
      price: "342.37",
      fxRateToSgd: "1.2816",
    });
    expect(appleTotal?.nativeGross).toBe("1711.85");
    expect(appleTotal?.totalSgd).toBe("2193.907");
  });

  describe("client market API cache, error classification, and backdating URLs", () => {
    beforeEach(() => {
      clearClientSearchCache();
    });

    it("caches recent search queries in client memory to avoid duplicate API calls", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ matches: [appleMatch] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      const first = await searchStocksClient("AAP", { fetchImpl: mockFetch });
      const second = await searchStocksClient("aap", { fetchImpl: mockFetch });

      expect(first).toEqual([appleMatch]);
      expect(second).toEqual([appleMatch]);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("classifies 429 rate-limit, network offline, and 404 exact-ticker misses clearly", async () => {
      const rateLimitFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "Rate limit exceeded on symbol search.",
            kind: "rate_limit",
          }),
          { status: 429 },
        ),
      );
      await expect(
        searchStocksClient("MSFT", { fetchImpl: rateLimitFetch }),
      ).rejects.toMatchObject({
        name: "ClientMarketError",
        kind: "rate_limit",
      });

      const offlineFetch = vi
        .fn()
        .mockRejectedValue(new TypeError("Failed to fetch"));
      await expect(
        searchStocksClient("NVDA", { fetchImpl: offlineFetch }),
      ).rejects.toMatchObject({
        name: "ClientMarketError",
        kind: "network",
      });

      const notFoundFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            match: null,
            error: 'No stock or ETF found with exact ticker "BOGUS999".',
          }),
          { status: 404 },
        ),
      );
      await expect(
        lookupExactSymbolClient("BOGUS999", { fetchImpl: notFoundFetch }),
      ).rejects.toThrow(ClientMarketError);
    });

    it("passes ?date=YYYY-MM-DD only when the trade date is in the past", async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.startsWith("/api/market/quote")) {
          return new Response(
            JSON.stringify({
              quote: {
                symbol: "AAPL",
                price: "151.49",
                previousClose: null,
                currency: "USD",
                exchangeCode: "NMS",
                asOf: "2021-11-03T20:00:00.000Z",
                effectiveDate: "2021-11-03",
                priceStatus: "historical",
                freshnessLabel: "Close on 3 Nov 2021",
                source: "yahoo",
              },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            fx: {
              from: "USD",
              to: "SGD",
              rate: "1.3489",
              effectiveDate: "2021-11-03",
              asOf: "2021-11-03T16:00:00.000Z",
              source: "frankfurter",
              label: "ECB rate, 3 Nov 2021",
              isHistorical: true,
            },
          }),
          { status: 200 },
        );
      });

      await fetchStockPriceClient("AAPL", "2026-11-07", "2026-11-07", {
        fetchImpl: mockFetch,
      });
      expect(mockFetch.mock.calls[0]?.[0]).toBe(
        "/api/market/quote?symbol=AAPL",
      );

      await Promise.all([
        fetchStockPriceClient("AAPL", "2021-11-03", "2026-11-07", {
          fetchImpl: mockFetch,
        }),
        fetchUsdToSgdClient("2021-11-03", "2026-11-07", {
          fetchImpl: mockFetch,
        }),
      ]);

      expect(mockFetch.mock.calls[1]?.[0]).toBe(
        "/api/market/quote?symbol=AAPL&date=2021-11-03",
      );
      expect(mockFetch.mock.calls[2]?.[0]).toBe(
        "/api/market/fx?from=USD&date=2021-11-03",
      );
    });

    it("hydrates existing transactions cleanly for editing", () => {
      const hydrated = createLinkedStockStateFromExisting({
        symbol: "ES3.SI",
        instrumentName: "SPDR Straits Times Index ETF",
        exchangeCode: "SES",
        currency: "SGD",
        price: "3.82",
        purchaseFxRate: null,
        isManualPrice: true,
      });
      expect(hydrated.exchangeDisplay).toBe("SGX");
      expect(hydrated.fxRateToSgd).toBe("1");
      expect(hydrated.isManualPrice).toBe(true);
      expect(hydrated.priceFreshnessLabel).toBe("Manual price");
    });
  });
});
