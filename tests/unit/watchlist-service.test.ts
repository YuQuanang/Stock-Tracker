import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import { toDecimal } from "@/lib/finance";
import {
  clearQuoteCache,
  type ResolvedInstrumentQuote,
} from "@/lib/market-data";
import {
  commitCsvImport,
  exportMspCsvFromDb,
} from "@/lib/services/csv-import-export";
import { createPortfolio, LedgerUserError } from "@/lib/services/ledger";
import {
  addWatchlistItem,
  getWatchlistPageSnapshot,
  previewPaperSimulation,
  removeWatchlistItem,
  reorderWatchlistItems,
  updateWatchlistItem,
} from "@/lib/services/watchlist";
import {
  compute52WeekRangePercent,
  computePaperComparison,
  computeWatchlistItemValuation,
  evaluatePriceAlert,
  type SerializedWatchlistItem,
} from "@/lib/watchlist/valuation";

const migrationsFolder = path.join(
  import.meta.dirname,
  "..",
  "..",
  "db",
  "migrations",
);
const fixturePath = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "MSP-Portfolios-2026-11-07.csv",
);
const fixtureCsv = fs.readFileSync(fixturePath, "utf8");

const offlineStubFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ rates: { "2020-01-02": { SGD: 1.345 } } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function makeYahooChartResponse(params: {
  symbol: string;
  currency: string;
  latestPrice: number;
  latestTimestampSec: number;
  historicalBars?: { dateIso: string; close: number }[];
}): Response {
  const timestamps = (params.historicalBars ?? []).map((bar) =>
    Math.floor(new Date(`${bar.dateIso}T14:30:00.000Z`).getTime() / 1000),
  );
  const closes = (params.historicalBars ?? []).map((bar) => bar.close);

  return new Response(
    JSON.stringify({
      chart: {
        result: [
          {
            meta: {
              symbol: params.symbol,
              currency: params.currency,
              exchangeName: params.currency === "SGD" ? "SES" : "NMS",
              exchangeTimezoneName:
                params.currency === "SGD"
                  ? "Asia/Singapore"
                  : "America/New_York",
              regularMarketPrice: params.latestPrice,
              regularMarketTime: params.latestTimestampSec,
              chartPreviousClose: closes[0] ?? params.latestPrice,
            },
            timestamp: timestamps,
            indicators: {
              quote: [
                {
                  close: closes,
                },
              ],
            },
          },
        ],
        error: null,
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

function makeResolvedQuote(params: {
  symbol: string;
  currency: "USD" | "SGD";
  price: string;
  previousClose: string;
}): ResolvedInstrumentQuote {
  const priceDec = toDecimal(params.price);
  const prevDec = toDecimal(params.previousClose);
  const diff = priceDec.minus(prevDec);
  const pct = diff.mul(100).div(prevDec);

  return {
    symbol: params.symbol,
    name: params.symbol,
    exchangeCode: params.currency === "SGD" ? "SGX" : "NASDAQ",
    currency: params.currency,
    assetType: "stock",
    price: params.price,
    previousClose: params.previousClose,
    dayChange: diff.toFixed(4),
    dayChangePercent: pct.toFixed(2),
    asOf: "2026-11-06T21:00:00.000Z",
    effectiveDate: "2026-11-06",
    status: "last_close",
    source: "yahoo",
    freshnessLabel: "Last close, 6 Nov",
    sparklineCloses: [params.previousClose, params.price],
  };
}

describe("Milestone 6: Watchlist Service, Valuation, Paper Simulator & Alerts", () => {
  let db: Database;

  beforeEach(async () => {
    clearQuoteCache();
    const client = new PGlite();
    db = drizzle(client, { schema }) as unknown as Database;
    await migrate(db as never, { migrationsFolder });
    await commitCsvImport(
      {
        filename: "MSP-Portfolios-2026-11-07.csv",
        csvText: fixtureCsv,
        duplicateMode: "replace",
        fetchImpl: offlineStubFetch,
      },
      db,
    );
  });

  it("loads the imported 'My Portfolio' watchlist with its 6 symbols and no fabricated priceWhenAdded", async () => {
    const snapshot = await getWatchlistPageSnapshot({
      db,
      fetchImpl: async () => new Response("offline", { status: 503 }),
    });

    const watchlists = snapshot.portfolios.filter((p) => p.type === "watchlist");
    expect(watchlists.map((w) => w.name)).toEqual(["My Portfolio"]);
    expect(snapshot.items.map((item) => item.symbol)).toEqual([
      "^DJI",
      "^GSPC",
      "^IXIC",
      "GOOG",
      "AAPL",
      "MSFT",
    ]);
    expect(snapshot.items.every((item) => item.priceWhenAdded === null)).toBe(
      true,
    );
  });

  it("records priceWhenAdded automatically on add, prevents duplicates (409), and rejects holdings portfolios (422)", async () => {
    const snapshot = await getWatchlistPageSnapshot({
      db,
      fetchImpl: async () => new Response("offline", { status: 503 }),
    });
    const myWatchlist = snapshot.portfolios.find((p) => p.type === "watchlist");
    const holdingsPortfolio = snapshot.portfolios.find(
      (p) => p.type === "holdings",
    );
    expect(myWatchlist).toBeDefined();
    expect(holdingsPortfolio).toBeDefined();

    const quoteStubFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("finance.yahoo.com")) {
        return makeYahooChartResponse({
          symbol: "D05.SI",
          currency: "SGD",
          latestPrice: 41.25,
          latestTimestampSec: 1793955600,
        });
      }
      return new Response("not found", { status: 404 });
    };

    const added = await addWatchlistItem(
      {
        portfolioId: myWatchlist!.id,
        symbol: "D05.SI",
        name: "DBS Group Holdings Ltd",
        exchangeCode: "SES",
        currency: "SGD",
        alertAbove: "45",
        alertBelow: "36.5",
      },
      { db, fetchImpl: quoteStubFetch },
    );

    expect(added.symbol).toBe("D05.SI");
    expect(added.currency).toBe("SGD");
    expect(added.priceWhenAdded).toBe("41.25");
    expect(added.alertAbove).toBe("45");
    expect(added.alertBelow).toBe("36.5");

    // Duplicate add -> 409
    await expect(
      addWatchlistItem(
        { portfolioId: myWatchlist!.id, symbol: "D05.SI" },
        { db, fetchImpl: quoteStubFetch },
      ),
    ).rejects.toMatchObject({
      name: "LedgerUserError",
      statusCode: 409,
    });

    // Adding to holdings portfolio -> 422
    await expect(
      addWatchlistItem(
        { portfolioId: holdingsPortfolio!.id, symbol: "CRWD" },
        { db, fetchImpl: quoteStubFetch },
      ),
    ).rejects.toBeInstanceOf(LedgerUserError);

    // Offline provider leaves priceWhenAdded null instead of inventing a price
    const offlineAdded = await addWatchlistItem(
      { portfolioId: myWatchlist!.id, symbol: "CRWD" },
      { db, fetchImpl: async () => new Response("down", { status: 503 }) },
    );
    expect(offlineAdded.symbol).toBe("CRWD");
    expect(offlineAdded.priceWhenAdded).toBeNull();
  });

  it("reorders and removes watchlist items cleanly while keeping MSP export lossless", async () => {
    const customList = await createPortfolio(
      { name: "Singapore Ideas", type: "watchlist", defaultCurrency: "SGD" },
      db,
    );

    const a = await addWatchlistItem(
      { portfolioId: customList.id, symbol: "D05.SI" },
      { db, fetchImpl: async () => new Response("down", { status: 503 }) },
    );
    const b = await addWatchlistItem(
      { portfolioId: customList.id, symbol: "O39.SI" },
      { db, fetchImpl: async () => new Response("down", { status: 503 }) },
    );
    const c = await addWatchlistItem(
      { portfolioId: customList.id, symbol: "U11.SI" },
      { db, fetchImpl: async () => new Response("down", { status: 503 }) },
    );

    await reorderWatchlistItems(
      {
        portfolioId: customList.id,
        orderedInstrumentIds: [c.instrumentId, a.instrumentId, b.instrumentId],
      },
      { db },
    );

    let afterReorder = await getWatchlistPageSnapshot({
      db,
      fetchImpl: async () => new Response("down", { status: 503 }),
    });
    expect(
      afterReorder.items
        .filter((i) => i.portfolioId === customList.id)
        .map((i) => i.symbol),
    ).toEqual(["U11.SI", "D05.SI", "O39.SI"]);

    await removeWatchlistItem(
      { portfolioId: customList.id, instrumentId: a.instrumentId },
      { db },
    );

    afterReorder = await getWatchlistPageSnapshot({
      db,
      fetchImpl: async () => new Response("down", { status: 503 }),
    });
    expect(
      afterReorder.items
        .filter((i) => i.portfolioId === customList.id)
        .map((i) => i.symbol),
    ).toEqual(["U11.SI", "O39.SI"]);

    // Existing My Portfolio export remains intact and new watchlist items export cleanly
    const exported = await exportMspCsvFromDb({}, db);
    expect(exported.content).toContain('"GOOG","Alphabet Inc.",,"NMS","My Portfolio"');
    expect(exported.content).toContain('"MSFT","Microsoft Corporation",,"NMS","My Portfolio"');
    expect(exported.content).toContain('"U11.SI",,,"SES","Singapore Ideas"');
    expect(exported.content).toContain('"O39.SI",,,"SES","Singapore Ideas"');
  });

  it("evaluates exact Decimal paper simulation, benchmark comparison, alerts, and 52-week range", async () => {
    const comp = computePaperComparison({
      amount: "1000",
      assetEntryPrice: "150",
      assetCurrentPrice: "225",
      benchmarkEntryPrice: "4000",
      benchmarkCurrentPrice: "5000",
    });

    expect(comp).not.toBeNull();
    expect(comp!.paperShares).toBe("6.66666667");
    expect(comp!.assetCurrentValue).toBe("1500");
    expect(comp!.assetGain).toBe("500");
    expect(comp!.assetGainPercent).toBe("50");
    expect(comp!.benchmarkShares).toBe("0.25");
    expect(comp!.benchmarkValue).toBe("1250");
    expect(comp!.benchmarkGain).toBe("250");
    expect(comp!.benchmarkGainPercent).toBe("25");
    expect(comp!.excessReturnPercent).toBe("25");

    expect(evaluatePriceAlert("225", "220", "180")).toBe("triggered-above");
    expect(evaluatePriceAlert("175", "220", "180")).toBe("triggered-below");
    expect(evaluatePriceAlert("200", "220", "180")).toBe("armed");
    expect(evaluatePriceAlert("200", null, null)).toBe("none");

    expect(compute52WeekRangePercent("150", "100", "200")).toBe(50);
    expect(compute52WeekRangePercent("90", "100", "200")).toBe(0);
    expect(compute52WeekRangePercent("250", "100", "200")).toBe(100);

    // Stubbed Yahoo Finance historical + latest preview and DB persistence
    const simFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("VOO")) {
        return makeYahooChartResponse({
          symbol: "VOO",
          currency: "USD",
          latestPrice: 500,
          latestTimestampSec: 1793998800,
          historicalBars: [{ dateIso: "2025-11-05", close: 400 }],
        });
      }
      if (url.includes("%5EGSPC") || url.includes("^GSPC")) {
        return makeYahooChartResponse({
          symbol: "^GSPC",
          currency: "USD",
          latestPrice: 5000,
          latestTimestampSec: 1793998800,
          historicalBars: [{ dateIso: "2025-11-05", close: 4000 }],
        });
      }
      if (url.includes("AAPL")) {
        return makeYahooChartResponse({
          symbol: "AAPL",
          currency: "USD",
          latestPrice: 180,
          latestTimestampSec: 1793998800,
          historicalBars: [{ dateIso: "2025-11-05", close: 120 }],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const preview = await previewPaperSimulation(
      {
        symbol: "AAPL",
        entryDate: "2025-11-05",
        amount: "1200",
        benchmarkSymbol: "^GSPC",
      },
      { db, fetchImpl: simFetch },
    );

    expect(preview.comparison.paperShares).toBe("10");
    expect(preview.comparison.assetCurrentValue).toBe("1800");
    expect(preview.comparison.assetGainPercent).toBe("50");
    expect(preview.comparison.benchmarkGainPercent).toBe("25");
    expect(preview.comparison.excessReturnPercent).toBe("25");

    const snapshot = await getWatchlistPageSnapshot({
      db,
      fetchImpl: async () => new Response("down", { status: 503 }),
    });
    const aaplItem = snapshot.items.find((i) => i.symbol === "AAPL")!;

    const updated = await updateWatchlistItem(
      {
        portfolioId: aaplItem.portfolioId,
        instrumentId: aaplItem.instrumentId,
        priceWhenAdded: "120",
        alertAbove: "175",
        alertBelow: "100",
        paperEntryDate: "2025-11-05",
        paperAmount: "1200",
      },
      { db, fetchImpl: simFetch },
    );

    expect(updated.paperShares).toBe("10");
    expect(updated.alertAbove).toBe("175");
    expect(updated.priceWhenAdded).toBe("120");

    const serializedForValuation: SerializedWatchlistItem = {
      ...updated,
      fiftyTwoWeekLow: "90",
      fiftyTwoWeekHigh: "190",
    };

    const valued = computeWatchlistItemValuation(
      serializedForValuation,
      makeResolvedQuote({
        symbol: "AAPL",
        currency: "USD",
        price: "180",
        previousClose: "170",
      }),
      "1.32",
      "SGD",
    );

    expect(valued.alertState).toBe("triggered-above");
    expect(valued.sinceAddedChange).toBe("60");
    expect(valued.sinceAddedPercent).toBe("50");
    expect(valued.range52wPercent).toBe(90);
    expect(valued.paperCurrentValue).toBe("1800");
    expect(valued.paperGain).toBe("600");
    expect(valued.paperGainPercent).toBe("50");
    expect(valued.paperCurrentValueBase).toBe("2376");
    expect(valued.paperExcessReturnPercent).toBe("25");

    // Clear paper simulation cleanly
    const cleared = await updateWatchlistItem(
      {
        portfolioId: aaplItem.portfolioId,
        instrumentId: aaplItem.instrumentId,
        clearPaperPosition: true,
      },
      { db, fetchImpl: simFetch },
    );
    expect(cleared.paperEntryDate).toBeNull();
    expect(cleared.paperAmount).toBeNull();
    expect(cleared.paperShares).toBeNull();
  });

  it("populates multi-point trend sparklines on first view even with empty price_bar cache", async () => {
    const firstViewFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("finance.yahoo.com")) {
        const symMatch = url.match(/chart\/([^?]+)/);
        const sym = symMatch ? decodeURIComponent(symMatch[1]) : "AAPL";
        return makeYahooChartResponse({
          symbol: sym,
          currency: "USD",
          latestPrice: 210,
          latestTimestampSec: Math.floor(
            new Date("2026-11-12T21:00:00.000Z").getTime() / 1000,
          ),
          historicalBars: [
            { dateIso: "2026-11-04", close: 192 },
            { dateIso: "2026-11-05", close: 196 },
            { dateIso: "2026-11-06", close: 201 },
            { dateIso: "2026-11-10", close: 204 },
            { dateIso: "2026-11-11", close: 207 },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const snapshot = await getWatchlistPageSnapshot({
      db,
      fetchImpl: firstViewFetch,
    });

    for (const symbol of ["^DJI", "^GSPC", "^IXIC", "GOOG", "AAPL", "MSFT"]) {
      const quote = snapshot.initialQuotes[symbol];
      expect(quote).toBeDefined();
      expect(quote.sparklineCloses?.length).toBeGreaterThanOrEqual(5);
      expect(quote.sparklineCloses?.[quote.sparklineCloses.length - 1]).toBe(
        "210",
      );
    }
  });
});
