import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import {
  clearFundamentalsCache,
  clearHistoryCaches,
  clearQuoteCache,
  ensureInstrumentDailyBars,
  fetchInstrumentFundamentals,
  getCombinedMarketOverview,
  MarketDataError,
  ProviderChain,
  resolveQuotesForSymbols,
} from "@/lib/market-data";
import {
  findOrCreateInstrument,
  updateInstrumentOverrides,
} from "@/lib/services/ledger";

const migrationsFolder = path.join(
  import.meta.dirname,
  "..",
  "..",
  "db",
  "migrations",
);

describe("Milestone 4: Market Data Layer (ProviderChain, Market Hours, History Cache, Fundamentals & Batch Quotes)", () => {
  let db: Database;

  beforeEach(async () => {
    clearQuoteCache();
    clearHistoryCaches();
    clearFundamentalsCache();

    const client = new PGlite();
    const pgliteDb = drizzle(client, { schema });
    await migrate(pgliteDb, { migrationsFolder });
    db = pgliteDb as unknown as Database;
  });

  it("trips circuit breaker on HTTP 429 rate-limit, ignores not_found, and recovers after cooldown", async () => {
    const chain = new ProviderChain({
      failureThreshold: 2,
      baseCooldownMs: 10_000,
      rateLimitCooldownMs: 30_000,
    });

    let yahooCalls = 0;
    let stooqCalls = 0;

    // 1. Yahoo returns 429 rate_limit -> circuit opens immediately for 30s, Stooq serves
    const first = await chain.execute(
      [
        {
          provider: "yahoo",
          execute: async () => {
            yahooCalls += 1;
            throw new MarketDataError("rate_limit", "Yahoo", "429 Too Many Requests");
          },
        },
        {
          provider: "stooq",
          execute: async () => {
            stooqCalls += 1;
            return "185.50";
          },
        },
      ],
      1_000,
    );

    expect(first).toEqual({ value: "185.50", provider: "stooq" });
    expect(yahooCalls).toBe(1);
    expect(stooqCalls).toBe(1);
    expect(chain.isCircuitOpen("yahoo", 5_000)).toBe(true);

    // 2. Subsequent call within 30s skips Yahoo completely without calling it!
    const second = await chain.execute(
      [
        {
          provider: "yahoo",
          execute: async () => {
            yahooCalls += 1;
            return "should-not-be-called";
          },
        },
        {
          provider: "stooq",
          execute: async () => {
            stooqCalls += 1;
            return "186.00";
          },
        },
      ],
      15_000,
    );

    expect(second).toEqual({ value: "186.00", provider: "stooq" });
    expect(yahooCalls).toBe(1); // Still 1!
    expect(stooqCalls).toBe(2);

    // 3. `not_found` errors do NOT trip Stooq's circuit
    chain.recordFailure(
      "stooq",
      new MarketDataError("not_found", "Stooq", "Ticker not found"),
      16_000,
    );
    chain.recordFailure(
      "stooq",
      new MarketDataError("not_found", "Stooq", "Ticker not found"),
      17_000,
    );
    expect(chain.isCircuitOpen("stooq", 18_000)).toBe(false);

    // 4. After 30s cooldown expires (`nowMs = 35_000`), Yahoo is tried again and resets
    const third = await chain.execute(
      [
        {
          provider: "yahoo",
          execute: async () => {
            yahooCalls += 1;
            return "187.25";
          },
        },
      ],
      35_000,
    );

    expect(third).toEqual({ value: "187.25", provider: "yahoo" });
    expect(yahooCalls).toBe(2);
    expect(chain.isCircuitOpen("yahoo", 35_000)).toBe(false);
  });

  it("evaluates weekend, holiday, and active session schedules accurately in Asia/Singapore", () => {
    // Saturday 2026-11-07 22:40 SGT (Note: Mon 2026-11-09 is SG public holiday!)
    const saturday = new Date("2026-11-07T22:40:00+08:00");
    const closedOverview = getCombinedMarketOverview(saturday);

    expect(closedOverview.anyMarketOpen).toBe(false);
    expect(closedOverview.us.isOpen).toBe(false);
    expect(closedOverview.sg.isOpen).toBe(false);
    expect(closedOverview.recommendedPollMs).toEqual({
      visibleMs: null,
      hiddenMs: null,
    });
    // US opens Monday 9 Nov 09:30 EST = Mon 22:30 SGT; SGX skips Mon 9 Nov holiday -> Tue 09:00 SGT!
    expect(closedOverview.us.nextOpenSgtLabel).toBe("Mon 22:30 SGT");
    expect(closedOverview.sg.nextOpenSgtLabel).toBe("Tue 09:00 SGT");
    expect(closedOverview.badgeLabel).toBe(
      "Markets closed · Opens Mon 22:30 SGT",
    );

    // Tuesday 2026-11-10 10:15 SGT -> SGX regular session open!
    const sgOpen = getCombinedMarketOverview(
      new Date("2026-11-10T10:15:00+08:00"),
    );
    expect(sgOpen.anyMarketOpen).toBe(true);
    expect(sgOpen.sg.isOpen).toBe(true);
    expect(sgOpen.sg.closesAtSgtLabel).toBe("Tue 17:00 SGT");
    expect(sgOpen.us.isOpen).toBe(false);
    expect(sgOpen.us.nextOpenSgtLabel).toBe("Tue 22:30 SGT");
    expect(sgOpen.badgeLabel).toBe("SGX open");
    expect(sgOpen.recommendedPollMs).toEqual({
      visibleMs: 12_000,
      hiddenMs: 45_000,
    });

    // Tuesday 2026-11-10 23:00 SGT (10:00 EST) -> US regular session open!
    const usOpen = getCombinedMarketOverview(
      new Date("2026-11-10T23:00:00+08:00"),
    );
    expect(usOpen.anyMarketOpen).toBe(true);
    expect(usOpen.us.isOpen).toBe(true);
    expect(usOpen.us.closesAtSgtLabel).toBe("Wed 05:00 SGT");
    expect(usOpen.sg.isOpen).toBe(false);
    expect(usOpen.sg.nextOpenSgtLabel).toBe("Wed 09:00 SGT");
    expect(usOpen.badgeLabel).toBe("US market open");
  });

  it("persists unadjusted daily bars in price_bar, serves subsequent closed-market reads from DB, and labels offline cache honestly", async () => {
    let networkCalls = 0;
    const saturday = new Date("2026-11-07T14:00:00Z");

    const yahooHistoryMock: typeof fetch = async (input) => {
      networkCalls += 1;
      const url = String(input);
      if (url.includes("finance.yahoo.com")) {
        // Two daily bars: Thu 2026-11-05 & Fri 2026-11-06
        return new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: {
                    symbol: "AAPL",
                    currency: "USD",
                    exchangeTimezoneName: "America/New_York",
                  },
                  timestamp: [1793912400, 1793998800], // 2026-11-05 & 2026-11-06 16:00 EST
                  indicators: {
                    quote: [
                      {
                        open: [220.1, 222.0],
                        high: [223.5, 225.4],
                        low: [219.8, 221.5],
                        close: [222.25, 224.5],
                        volume: [41000000, 45200000],
                      },
                    ],
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("Not Found", { status: 404 });
    };

    const firstRead = await ensureInstrumentDailyBars({
      symbol: "AAPL",
      startDate: "2026-11-01",
      endDate: "2026-11-07",
      db,
      now: saturday,
      fetchImpl: yahooHistoryMock,
    });

    expect(firstRead.status).toBe("ok");
    expect(firstRead.bars).toHaveLength(2);
    expect(firstRead.bars[1]).toMatchObject({
      date: "2026-11-06",
      close: "224.5",
      volume: "45200000",
    });
    expect(networkCalls).toBe(1);

    // Second read on Saturday hits `price_bar` DB cache directly with 0 network calls!
    const secondRead = await ensureInstrumentDailyBars({
      symbol: "AAPL",
      startDate: "2026-11-01",
      endDate: "2026-11-07",
      db,
      now: saturday,
      fetchImpl: yahooHistoryMock,
    });
    expect(secondRead.status).toBe("ok");
    expect(secondRead.bars).toHaveLength(2);
    expect(networkCalls).toBe(1);

    // Forced refresh while offline returns `stale_cache` (never fabricates or hides staleness)
    const offlineFetch: typeof fetch = async () => {
      throw new Error("Offline");
    };
    const offlineRead = await ensureInstrumentDailyBars({
      symbol: "AAPL",
      startDate: "2026-11-01",
      endDate: "2026-11-07",
      db,
      now: saturday,
      fetchImpl: offlineFetch,
      chain: new ProviderChain(),
      forceRefresh: true,
    });
    expect(offlineRead.status).toBe("stale_cache");
    expect(offlineRead.bars).toHaveLength(2);

    // Crypto history never calls external providers
    const cryptoRead = await ensureInstrumentDailyBars({
      symbol: "UST-USD",
      startDate: "2026-01-01",
      endDate: "2026-11-07",
      db,
      now: saturday,
      fetchImpl: yahooHistoryMock,
    });
    expect(cryptoRead.status).toBe("unavailable");
    expect(cryptoRead.bars).toHaveLength(0);
    expect(networkCalls).toBe(1);
  });

  it("caches company fundamentals for 24 hours and skips crypto symbols", async () => {
    let calls = 0;
    const mockFetch: typeof fetch = async (input) => {
      calls += 1;
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("scanner.tradingview.com")) {
        return new Response(
          JSON.stringify({
            totalCount: 1,
            data: [
              {
                s: "SGX:ES3",
                d: [
                  "ES3",
                  "State Street SPDR Straits Times Index ETF Units",
                  "SGD",
                  null,
                  null,
                  3.55,
                  null,
                  3.88,
                  3.19,
                  0.98,
                  2041811,
                  "Miscellaneous",
                  "Investment Trusts/Mutual Funds",
                ],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          chart: {
            result: [
              {
                meta: {
                  symbol: "ES3.SI",
                  longName: "SPDR Straits Times Index ETF",
                  currency: "SGD",
                  exchangeName: "SES",
                  fiftyTwoWeekHigh: 3.88,
                  fiftyTwoWeekLow: 3.19,
                },
                indicators: {
                  quote: [
                    {
                      high: [3.85, 3.88],
                      low: [3.19, 3.4],
                      close: [3.5, 3.82],
                      volume: [1200000, 1800000],
                    },
                  ],
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const first = await fetchInstrumentFundamentals("ES3.SI", {
      fetchImpl: mockFetch,
    });
    expect(first.status).toBe("ok");
    expect(first.name).toBe("SPDR Straits Times Index ETF");
    expect(first.currency).toBe("SGD");
    expect(first.fiftyTwoWeekHigh).toBe("3.88");
    expect(first.fiftyTwoWeekLow).toBe("3.19");
    expect(first.averageVolume).toBe("1500000");
    expect(first.dividendYieldPercent).toBe("3.55");
    expect(first.beta).toBe("0.98");
    expect(first.sector).toBe("Miscellaneous");
    expect(calls).toBe(2);

    // Cached for 24h -> 0 extra network calls
    const second = await fetchInstrumentFundamentals("ES3.SI", {
      fetchImpl: mockFetch,
    });
    expect(second.fiftyTwoWeekHigh).toBe("3.88");
    expect(calls).toBe(2);

    // Crypto immediately returns unavailable with 0 network calls
    const crypto = await fetchInstrumentFundamentals("ETH-SGD", {
      fetchImpl: mockFetch,
    });
    expect(crypto.status).toBe("unavailable");
    expect(calls).toBe(2);
  });

  it("resolves batch quotes with exact dayChange math, manual/delisted overrides, crypto exclusion, and labelled offline fallback", async () => {
    const saturday = new Date("2026-11-07T14:00:00Z");

    const nvda = await findOrCreateInstrument(
      { symbol: "NVDA", name: "NVIDIA Corp.", currency: "USD" },
      db,
    );
    const deadCoin = await findOrCreateInstrument(
      { symbol: "UST-USD", name: "TerraUSD", currency: "USD", assetType: "crypto" },
      db,
    );
    const delistedStock = await findOrCreateInstrument(
      { symbol: "HIBB", name: "Hibbett", currency: "USD" },
      db,
    );
    await updateInstrumentOverrides(delistedStock.id, { isDelisted: true }, db);

    const manualToken = await findOrCreateInstrument(
      { symbol: "VVS-USD", name: "VVS Finance", currency: "USD", assetType: "crypto" },
      db,
    );
    await updateInstrumentOverrides(
      manualToken.id,
      { manualPrice: "0.000004" },
      db,
    );

    const requestedUrls: string[] = [];
    const liveMockFetch: typeof fetch = async (input) => {
      const url = String(input);
      requestedUrls.push(url);

      if (url.includes("NVDA")) {
        return new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: {
                    symbol: "NVDA",
                    currency: "USD",
                    exchangeName: "NMS",
                    exchangeTimezoneName: "America/New_York",
                    regularMarketPrice: 204,
                    chartPreviousClose: 200,
                    regularMarketTime: 1793998800, // 2026-11-06 16:00 EST
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("Not Found", { status: 404 });
    };

    const batch = await resolveQuotesForSymbols({
      symbols: [nvda.symbol, deadCoin.symbol, "HIBB", "VVS-USD"],
      db,
      now: saturday,
      fetchImpl: liveMockFetch,
      chain: new ProviderChain(),
      skipCache: true,
    });

    // 1. NVDA live/last-close quote + exact dayChange (+4 / +2%)
    expect(batch.NVDA).toMatchObject({
      symbol: "NVDA",
      price: "204",
      previousClose: "200",
      dayChange: "4",
      dayChangePercent: "2",
      status: "last_close",
      freshnessLabel: "Last close, 6 Nov",
    });

    // 2. UST-USD (unpriced crypto) -> unavailable, zero external requests for UST-USD
    expect(batch["UST-USD"].status).toBe("unavailable");
    expect(batch["UST-USD"].price).toBeNull();
    expect(requestedUrls.some((u) => u.includes("UST-USD"))).toBe(false);

    // 3. HIBB (delisted) -> $0 delisted override
    expect(batch.HIBB.status).toBe("delisted");
    expect(batch.HIBB.price).toBe("0");

    // 4. VVS-USD (manual price override on crypto) -> exact manual decimal preserved
    expect(batch["VVS-USD"].status).toBe("manual");
    expect(batch["VVS-USD"].price).toBe("0.000004");

    // 5. Simulate total network outage -> NVDA falls back to persisted `price_bar`
    //    explicitly labelled `stale_cache` ("Cached close, 6 Nov (offline)")!
    const offlineBatch = await resolveQuotesForSymbols({
      symbols: ["NVDA", "UNSEEN_TICKER"],
      db,
      now: saturday,
      fetchImpl: async () => {
        throw new Error("Network down");
      },
      chain: new ProviderChain(),
      skipCache: true,
    });

    expect(offlineBatch.NVDA.status).toBe("stale_cache");
    expect(offlineBatch.NVDA.price).toBe("204");
    expect(offlineBatch.NVDA.freshnessLabel).toBe(
      "Cached close, 6 Nov (offline)",
    );

    // Unseen ticker with no cached `price_bar` honestly reports `unavailable`
    expect(offlineBatch.UNSEEN_TICKER.status).toBe("unavailable");
    expect(offlineBatch.UNSEEN_TICKER.price).toBeNull();
  });

  it("persists priceNotFoundAt on 404, skips repeat HTTP calls across cache clears, ignores transient outages, and clears on retryNotFound recovery", async () => {
    const saturday = new Date("2026-11-07T14:00:00Z");

    await findOrCreateInstrument(
      { symbol: "MISSING.SI", name: "Delisted REIT", currency: "SGD" },
      db,
    );
    await findOrCreateInstrument(
      { symbol: "FLAKY", name: "Transient Network Co", currency: "USD" },
      db,
    );

    let missingRequests = 0;
    const notFoundFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("MISSING.SI")) {
        missingRequests += 1;
        return new Response(
          JSON.stringify({
            chart: {
              result: null,
              error: { code: "Not Found", description: "No data found" },
            },
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("Internal Server Error", { status: 500 });
    };

    // 1. First lookup: MISSING.SI returns 404 -> persisted as priceNotFoundAt;
    //    FLAKY returns 500 -> transient failure, must NOT be marked priceNotFoundAt.
    const firstBatch = await resolveQuotesForSymbols({
      symbols: ["MISSING.SI", "FLAKY"],
      db,
      now: saturday,
      fetchImpl: notFoundFetch,
      chain: new ProviderChain(),
    });

    expect(firstBatch["MISSING.SI"].status).toBe("unavailable");
    expect(firstBatch["MISSING.SI"].price).toBeNull();
    expect(firstBatch["MISSING.SI"].priceNotFound).toBe(true);
    expect(firstBatch.FLAKY.price).toBeNull();
    expect(firstBatch.FLAKY.priceNotFound).toBeFalsy();
    expect(missingRequests).toBeGreaterThan(0);

    const [missingRow] = await db
      .select()
      .from(schema.instrument)
      .where(eq(schema.instrument.symbol, "MISSING.SI"));
    expect(missingRow.priceNotFoundAt).not.toBeNull();
    expect(missingRow.priceNotFoundReason).toBeTruthy();

    const [flakyRow] = await db
      .select()
      .from(schema.instrument)
      .where(eq(schema.instrument.symbol, "FLAKY"));
    expect(flakyRow.priceNotFoundAt).toBeNull();

    // 2. Even after clearing memory quote & history caches (like a cold restart),
    //    both batch quotes and daily bar sync short-circuit with 0 HTTP requests.
    clearQuoteCache();
    clearHistoryCaches();
    missingRequests = 0;

    const repeatBatch = await resolveQuotesForSymbols({
      symbols: ["MISSING.SI"],
      db,
      now: saturday,
      fetchImpl: notFoundFetch,
      chain: new ProviderChain(),
    });
    expect(repeatBatch["MISSING.SI"].status).toBe("unavailable");
    expect(repeatBatch["MISSING.SI"].priceNotFound).toBe(true);
    expect(missingRequests).toBe(0);

    await ensureInstrumentDailyBars({
      symbol: "MISSING.SI",
      startDate: "2026-10-01",
      endDate: "2026-11-06",
      db,
      now: saturday,
      fetchImpl: notFoundFetch,
    });
    expect(missingRequests).toBe(0);

    // 3. Explicit retryNotFound=true queries live providers and clears DB flag on recovery
    let recoveredRequests = 0;
    const recoveredFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("query1.finance.yahoo.com") && url.includes("MISSING.SI")) {
        recoveredRequests += 1;
        return new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: {
                    currency: "SGD",
                    symbol: "MISSING.SI",
                    exchangeName: "SES",
                    regularMarketPrice: 1.25,
                    chartPreviousClose: 1.2,
                    regularMarketTime: Math.floor(
                      new Date("2026-11-06T09:00:00Z").getTime() / 1000,
                    ),
                  },
                },
              ],
              error: null,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("Not Found", { status: 404 });
    };

    const retryBatch = await resolveQuotesForSymbols({
      symbols: ["MISSING.SI"],
      db,
      now: saturday,
      fetchImpl: recoveredFetch,
      chain: new ProviderChain(),
      skipCache: true,
      retryNotFound: true,
    });

    expect(recoveredRequests).toBe(1);
    expect(retryBatch["MISSING.SI"].status).toBe("last_close");
    expect(retryBatch["MISSING.SI"].price).toBe("1.25");
    expect(retryBatch["MISSING.SI"].priceNotFound).toBeFalsy();

    const [clearedRow] = await db
      .select()
      .from(schema.instrument)
      .where(eq(schema.instrument.symbol, "MISSING.SI"));
    expect(clearedRow.priceNotFoundAt).toBeNull();
    expect(clearedRow.priceNotFoundReason).toBeNull();
  });
});

