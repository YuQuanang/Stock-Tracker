import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import { filterPointsByAnalyticsRange } from "@/lib/charts/theme";
import {
  clearQuoteCache,
  clearSymbolSearchCache,
  fetchDailyBarsViaTradingView,
  fetchStockPrice,
  getSgxTickerTransition,
  lookupExactSymbol,
  ProviderChain,
  resolveStartDateForRange,
  searchSymbols,
  type TradingViewWebSocketLike,
} from "@/lib/market-data";
import {
  computeLedgerSummaries,
  createPortfolio,
  createTransaction,
  findOrCreateInstrument,
  listEnrichedTransactions,
  migrateInstrumentSymbol,
} from "@/lib/services/ledger";
import { addWatchlistItem } from "@/lib/services/watchlist";

const migrationsFolder = path.join(
  import.meta.dirname,
  "..",
  "..",
  "db",
  "migrations",
);

describe("SGX market-data coverage (TradingView provider & J91U.SI -> 9A4U.SI transition)", () => {
  beforeEach(() => {
    clearQuoteCache();
    clearSymbolSearchCache();
  });

  it("falls back to TradingView Singapore scanner for .SI and ^STI quotes with exact previousClose math", async () => {
    const chain = new ProviderChain();
    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("query1.finance.yahoo.com")) {
        return new Response(JSON.stringify({ chart: { result: null } }), {
          status: 429,
        });
      }
      if (url.includes("scanner.tradingview.com/singapore/scan")) {
        return new Response(
          JSON.stringify({
            totalCount: 1,
            data: [
              {
                s: "SGX:GLS",
                d: [
                  "GLS",
                  "LionGlobal Singapore Physical Gold Fund Units",
                  5.398,
                  -0.5343652109821249,
                  -0.028999999999999915,
                  "SGD",
                  "SGX",
                  "delayed_streaming_600",
                  1794531600,
                  1000,
                ],
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          totalCount: 1,
          data: [
            {
              s: "TVC:STI",
              d: [
                "STI",
                "STRAITS TIMES INDEX",
                5231.85,
                -0.96,
                -50.85999999999967,
                "SGD",
                "TVC",
                "streaming",
                1794531600,
                100,
              ],
            },
          ],
        }),
        { status: 200 },
      );
    };

    // Friday 2026-11-13 11:00 SGT (03:00Z): SGX session open
    const marketOpen = new Date("2026-11-13T03:00:00.000Z");
    const glsQuote = await fetchStockPrice("GLS.SI", {
      now: marketOpen,
      chain,
      fetchImpl: mockFetch,
    });

    expect(glsQuote.source).toBe("tradingview");
    expect(glsQuote.price).toBe("5.398");
    expect(glsQuote.previousClose).toBe("5.427");
    expect(glsQuote.currency).toBe("SGD");
    expect(glsQuote.exchangeCode).toBe("SES");
    expect(glsQuote.priceStatus).toBe("delayed");
    expect(glsQuote.freshnessLabel).toBe("Delayed ~10 min");

    // Circuit breaker opened for Yahoo on 429, so `^STI` resolves directly on TradingView
    const stiQuote = await fetchStockPrice("^STI", {
      now: marketOpen,
      chain,
      fetchImpl: mockFetch,
    });
    expect(stiQuote.source).toBe("tradingview");
    expect(stiQuote.price).toBe("5231.85");
    expect(stiQuote.previousClose).toBe("5282.71");
    expect(stiQuote.priceStatus).toBe("live");
  });

  it("prefers yesterday's daily close bar over 5-day chartPreviousClose in Yahoo range=5d responses", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        chart: {
          result: [
            {
              meta: {
                symbol: "GLS.SI",
                currency: "SGD",
                exchangeName: "SES",
                exchangeTimezoneName: "Asia/Singapore",
                regularMarketPrice: 5.398,
                regularMarketTime: 1794561266, // 2026-11-13 17:14 SGT
                chartPreviousClose: 5.655,
              },
              timestamp: [1794445200, 1794531600], // Nov 12 & Nov 13 09:00 SGT
              indicators: {
                quote: [{ close: [5.427000045776367, 5.3979997634887695] }],
              },
            },
          ],
        },
      }),
    });

    const quote = await fetchStockPrice("GLS.SI", {
      now: new Date("2026-11-15T04:00:00.000Z"),
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    expect(quote.price).toBe("5.398");
    expect(quote.previousClose).toBe("5.427");
  });

  it("explains ESR-REIT J91U.SI -> 9A4U.SI 10-for-1 consolidation when providers report not_found", async () => {
    const transition = getSgxTickerTransition("J91U.SI");
    expect(transition?.newSymbol).toBe("9A4U.SI");
    expect(transition?.ratioNumerator).toBe(1);
    expect(transition?.ratioDenominator).toBe(10);

    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("query1.finance.yahoo.com")) {
        return new Response(
          JSON.stringify({ chart: { result: null, error: { code: "Not Found" } } }),
          { status: 404 },
        );
      }
      if (url.includes("scanner.tradingview.com")) {
        return new Response(JSON.stringify({ totalCount: 0, data: [] }), {
          status: 200,
        });
      }
      return new Response("Date,Open,High,Low,Close,Volume\nNo data", {
        status: 200,
      });
    };

    await expect(
      fetchStockPrice("J91U.SI", {
        chain: new ProviderChain(),
        fetchImpl: mockFetch,
      }),
    ).rejects.toMatchObject({
      name: "MarketDataError",
      kind: "not_found",
      message: expect.stringContaining("9A4U.SI"),
    });
  });

  it("augments stale Twelve Data search with TradingView SGX results and verifies .SI exact symbols", async () => {
    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api.twelvedata.com")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            data: [
              {
                symbol: "J91U",
                instrument_name: "ESR-REIT",
                exchange: "SGX",
                mic_code: "XSES",
                country: "Singapore",
                currency: "SGD",
                instrument_type: "REIT",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("symbol-search.tradingview.com")) {
        return new Response(
          JSON.stringify({
            symbols: [
              {
                symbol: "9A4U",
                description: "ESR-REIT",
                type: "stock",
                exchange: "SGX",
                currency_code: "SGD",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("query1.finance.yahoo.com")) {
        return new Response(JSON.stringify({ chart: { result: null } }), {
          status: 404,
        });
      }
      if (url.includes("scanner.tradingview.com/singapore/scan")) {
        return new Response(
          JSON.stringify({
            totalCount: 1,
            data: [
              {
                s: "SGX:HYDD",
                d: [
                  "HYDD",
                  "BYD Company Limited Shs UnSp Singapore Depositary Receipt Repr 1/10 Sh",
                  "dr",
                  "",
                  "SGD",
                  "SGX",
                ],
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    };

    const matches = await searchSymbols("ESR-REIT", {
      fetchImpl: mockFetch,
      skipCache: true,
    });
    expect(matches.map((m) => m.symbol)).toEqual(["9A4U.SI"]);
    expect(matches[0].exchangeDisplay).toBe("SGX");

    const exactSdr = await lookupExactSymbol("hydd.si", {
      fetchImpl: mockFetch,
      skipCache: true,
    });
    expect(exactSdr?.symbol).toBe("HYDD.SI");
    expect(exactSdr?.currency).toBe("SGD");
  });

  it("migrates retired J91U.SI -> 9A4U.SI across portfolios, records 1:10 consolidation, and preserves cost basis", async () => {
    const client = new PGlite();
    const pgliteDb = drizzle(client, { schema });
    await migrate(pgliteDb, { migrationsFolder });
    const db = pgliteDb as unknown as Database;

    const currentPf = await createPortfolio(
      { name: "Current", type: "holdings", defaultCurrency: "SGD" },
      db,
    );
    const wlPf = await createPortfolio(
      { name: "SG Watch", type: "watchlist", defaultCurrency: "SGD" },
      db,
    );

    const oldInstr = await findOrCreateInstrument(
      { symbol: "J91U.SI", name: "Esr-reit", currency: "SGD" },
      db,
    );
    await db
      .update(schema.instrument)
      .set({
        priceNotFoundAt: new Date("2026-11-10T00:00:00Z"),
        priceNotFoundReason: "No data found",
      })
      .where(eq(schema.instrument.id, oldInstr.id));

    await createTransaction(
      {
        portfolioId: currentPf.id,
        symbol: "J91U.SI",
        type: "Buy",
        quantity: "400",
        price: "0.465",
        commission: "0",
        date: "2025-02-05",
        time: "11:22:00",
      },
      db,
    );
    await createTransaction(
      {
        portfolioId: currentPf.id,
        symbol: "J91U.SI",
        type: "Buy",
        quantity: "200",
        price: "0.365",
        commission: "0",
        date: "2025-02-05",
        time: "11:29:00",
      },
      db,
    );

    const mockWatchlistFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ chart: { result: null } }), { status: 404 });

    // Simulate both J91U.SI and 9A4U.SI on the same watchlist to test link merging
    await addWatchlistItem(
      {
        portfolioId: wlPf.id,
        symbol: "J91U.SI",
        name: "ESR-REIT",
        exchangeCode: "SES",
        currency: "SGD",
        alertBelow: "0.30",
      },
      { db, fetchImpl: mockWatchlistFetch },
    );
    await addWatchlistItem(
      {
        portfolioId: wlPf.id,
        symbol: "9A4U.SI",
        name: "ESR-REIT",
        exchangeCode: "SES",
        currency: "SGD",
        alertAbove: "2.50",
      },
      { db, fetchImpl: mockWatchlistFetch },
    );

    const result = await migrateInstrumentSymbol(
      oldInstr.id,
      {
        targetSymbol: "9A4U.SI",
        targetName: "ESR-REIT",
        applyConsolidationSplit: true,
        exDate: "2025-04-30",
        ratioNumerator: 1,
        ratioDenominator: 10,
      },
      db,
    );

    expect(result.instrument.symbol).toBe("9A4U.SI");
    expect(result.instrument.priceNotFoundAt).toBeNull();
    expect(result.appliedSplit).toBe(true);

    const txRows = await listEnrichedTransactions(
      { portfolioId: currentPf.id, instrumentId: result.instrument.id },
      db,
    );
    expect(txRows).toHaveLength(2);

    const ledger = await computeLedgerSummaries(currentPf.id, db);
    const summary = ledger.positions.find(
      (p) => p.instrumentId === result.instrument.id,
    );
    expect(summary?.sharesHeld).toBe("60");
    expect(summary?.openCostBasis).toBe("259");
    expect(Number(summary?.averageCostPerShare)).toBeCloseTo(259 / 60, 6);
  });

  it("resolves 3Y chart ranges and parses 5Y daily bars via TradingView WebSocket fallback", async () => {
    expect(resolveStartDateForRange("3Y", "2026-11-15")).toBe("2023-11-15");

    const analyticsPoints = [
      { date: "2021-11-15", v: 1 },
      { date: "2023-11-15", v: 2 },
      { date: "2025-02-05", v: 3 },
      { date: "2026-11-15", v: 4 },
    ];
    expect(filterPointsByAnalyticsRange(analyticsPoints, "3Y")).toEqual([
      { date: "2023-11-15", v: 2 },
      { date: "2025-02-05", v: 3 },
      { date: "2026-11-15", v: 4 },
    ]);

    const wrap = (obj: unknown): string => {
      const s = typeof obj === "string" ? obj : JSON.stringify(obj);
      return `~m~${s.length}~m~${s}`;
    };

    const sentFrames: string[] = [];
    const makeMockWsFactory = (
      currencyCode: "USD" | "SGD",
      timezone: string,
    ): (() => TradingViewWebSocketLike) => {
      return () => {
        const listeners = new Map<
          string,
          Array<(event: { data?: unknown; message?: unknown }) => void>
        >();
        const emit = (type: string, event: { data?: unknown } = {}) => {
          for (const fn of listeners.get(type) ?? []) {
            fn(event);
          }
        };

        const socket: TradingViewWebSocketLike = {
          addEventListener: (type, fn) => {
            const list = listeners.get(type) ?? [];
            list.push(fn);
            listeners.set(type, list);
            if (type === "open") {
              queueMicrotask(() => emit("open"));
            }
          },
          send: (data) => {
            sentFrames.push(data);
            if (data.includes('"m":"create_series"')) {
              queueMicrotask(() => {
                emit("message", {
                  data: wrap("~h~1"),
                });
                emit("message", {
                  data:
                    wrap({
                      m: "symbol_resolved",
                      p: [
                        "cs_test",
                        "sds_sym_1",
                        {
                          timezone,
                          currency_code: currencyCode,
                        },
                      ],
                    }) +
                    wrap({
                      m: "timescale_update",
                      p: [
                        "cs_test",
                        {
                          sds_1: {
                            s: [
                              // 2021-11-16 09:00 SGT & 2026-11-13 09:00 SGT
                              { v: [1637024400, 31.1, 31.5, 31.0, 31.4, 2100000] },
                              { v: [1794531600, 70.4, 70.45, 69.83, 69.9, 4209550] },
                            ],
                          },
                        },
                      ],
                    }) +
                    wrap({ m: "series_completed", p: ["cs_test", "sds_1"] }),
                });
              });
            }
          },
          close: () => undefined,
        };
        return socket;
      };
    };

    const tvResult = await fetchDailyBarsViaTradingView({
      symbol: "D05.SI",
      startDate: "2021-11-15",
      endDate: "2026-11-15",
      wsFactory: makeMockWsFactory("SGD", "Asia/Singapore"),
    });

    expect(tvResult.currency).toBe("SGD");
    expect(tvResult.bars).toEqual([
      {
        date: "2021-11-16",
        open: "31.1",
        high: "31.5",
        low: "31",
        close: "31.4",
        volume: "2100000",
        source: "tradingview",
      },
      {
        date: "2026-11-13",
        open: "70.4",
        high: "70.45",
        low: "69.83",
        close: "69.9",
        volume: "4209550",
        source: "tradingview",
      },
    ]);
    expect(
      sentFrames.some(
        (f) => f.includes('"m":"resolve_symbol"') && f.includes("SGX:D05"),
      ),
    ).toBe(true);
    expect(sentFrames.some((f) => f === "~m~4~m~~h~1")).toBe(true);

    const usMockFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("symbol-search.tradingview.com")) {
        return new Response(
          JSON.stringify({
            symbols: [
              {
                symbol: "NVDA",
                description: "NVIDIA Corporation",
                exchange: "NASDAQ",
                currency_code: "USD",
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("Not Found", { status: 404 });
    };

    const usTvResult = await fetchDailyBarsViaTradingView({
      symbol: "NVDA",
      startDate: "2021-11-15",
      endDate: "2026-11-15",
      fetchImpl: usMockFetch,
      wsFactory: makeMockWsFactory("USD", "America/New_York"),
    });
    expect(usTvResult.currency).toBe("USD");
    expect(usTvResult.bars).toHaveLength(2);
    expect(
      sentFrames.some(
        (f) => f.includes('"m":"resolve_symbol"') && f.includes("NASDAQ:NVDA"),
      ),
    ).toBe(true);
  });
});
