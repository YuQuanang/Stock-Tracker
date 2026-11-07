import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearFxCache, fetchExchangeRateToSgd } from "@/lib/market-data/fx";

describe("Step (c): live and historical USD -> SGD exchange rate fetch", () => {
  beforeEach(() => {
    clearFxCache();
  });

  it("returns 1 immediately for SGD without making any network call", async () => {
    const mockFetch = vi.fn();
    const sgd = await fetchExchangeRateToSgd({
      from: "SGD",
      now: new Date("2026-11-07T04:30:00.000Z"),
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    expect(sgd.rate).toBe("1");
    expect(sgd.source).toBe("native-sgd");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fetches latest ECB USD->SGD rate via Frankfurter and caches it", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        amount: 1,
        base: "USD",
        date: "2026-11-06",
        rates: { SGD: 1.2816 },
      }),
    });

    const first = await fetchExchangeRateToSgd({
      from: "USD",
      now: new Date("2026-11-07T04:30:00.000Z"),
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(first.rate).toBe("1.2816");
    expect(first.source).toBe("frankfurter");
    expect(first.label).toBe("ECB rate, 6 Nov");

    const second = await fetchExchangeRateToSgd({
      from: "USD",
      now: new Date("2026-11-07T04:30:00.000Z"),
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(second.rate).toBe("1.2816");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to Yahoo SGD=X if Frankfurter is unreachable", async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          chart: {
            result: [
              {
                meta: {
                  regularMarketPrice: 1.2835,
                  regularMarketTime: 1793998800,
                },
              },
            ],
          },
        }),
      });

    const fallback = await fetchExchangeRateToSgd({
      from: "USD",
      now: new Date("2026-11-07T04:30:00.000Z"),
      fetchImpl: mockFetch as unknown as typeof fetch,
      skipCache: true,
    });
    expect(fallback.rate).toBe("1.2835");
    expect(fallback.source).toBe("yahoo");
  });
});

