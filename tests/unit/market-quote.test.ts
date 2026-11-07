import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMarketSessionStatus } from "@/lib/market-data/hours";
import { clearQuoteCache, fetchStockPrice } from "@/lib/market-data/quotes";

describe("Step (b): market hours and stock price fetching", () => {
  beforeEach(() => {
    clearQuoteCache();
  });

  it("identifies weekends and regular sessions across US and SGX timezones", () => {
    // Saturday 2026-11-07 14:00 SGT = Saturday 2026-11-07 01:00 EST (both on weekend)
    const saturdayBoth = new Date("2026-11-07T06:00:00.000Z");
    expect(getMarketSessionStatus("US", saturdayBoth)).toMatchObject({
      isOpen: false,
      reason: "weekend",
    });
    expect(getMarketSessionStatus("SG", saturdayBoth)).toMatchObject({
      isOpen: false,
      reason: "weekend",
    });

    // Saturday 12:30 SGT is still Friday 23:30 EST ("outside-hours" in NY)
    const fridayLateNy = new Date("2026-11-07T04:30:00.000Z");
    expect(getMarketSessionStatus("US", fridayLateNy)).toMatchObject({
      isOpen: false,
      reason: "outside-hours",
    });

    // Wednesday 2026-11-04 15:00 UTC = 10:00 AM EST (US open) & 23:00 SGT (SG closed)
    const wednesday = new Date("2026-11-04T15:00:00.000Z");
    expect(getMarketSessionStatus("US", wednesday).isOpen).toBe(true);
    expect(getMarketSessionStatus("SG", wednesday).isOpen).toBe(false);
  });

  it("labels weekend latest quotes as Last close with exact decimal formatting", async () => {
    // Friday 2026-11-06 16:00 EST = 1793998800
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        chart: {
          result: [
            {
              meta: {
                symbol: "AAPL",
                currency: "USD",
                exchangeName: "NMS",
                exchangeTimezoneName: "America/New_York",
                regularMarketPrice: 342.37,
                regularMarketTime: 1793998800,
                chartPreviousClose: 344.63,
              },
            },
          ],
        },
      }),
    });

    const quote = await fetchStockPrice("AAPL", {
      now: new Date("2026-11-07T04:30:00.000Z"),
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    expect(quote.price).toBe("342.37");
    expect(quote.currency).toBe("USD");
    expect(quote.priceStatus).toBe("last_close");
    expect(quote.freshnessLabel).toBe("Last close, 6 Nov");
  });

  it("fetches historical closing price on or before a backdated trade date", async () => {
    // Friday 2024-03-08 16:00 EST = 1709931600; user backdated to Sunday 2024-03-10
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        chart: {
          result: [
            {
              meta: {
                symbol: "AAPL",
                currency: "USD",
                exchangeName: "NMS",
                exchangeTimezoneName: "America/New_York",
              },
              timestamp: [1709845200, 1709931600],
              indicators: {
                quote: [{ close: [169.0, 170.73] }],
              },
            },
          ],
        },
      }),
    });

    const historical = await fetchStockPrice("AAPL", {
      date: "2024-03-10",
      now: new Date("2026-11-07T04:30:00.000Z"),
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    expect(historical.price).toBe("170.73");
    expect(historical.effectiveDate).toBe("2024-03-08");
    expect(historical.priceStatus).toBe("historical");
    expect(historical.freshnessLabel).toBe("Close on 8 Mar 2024");
  });
});
