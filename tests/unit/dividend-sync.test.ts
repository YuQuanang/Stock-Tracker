import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StockDetailView } from "@/components/holdings/stock-detail-view";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    refresh: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  }),
}));
import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import { computePortfolioAnalytics } from "@/lib/services/analytics";
import {
  clearDividendSyncCaches,
  resolveDividendWithholdingTaxPercent,
  syncPortfolioDividends,
} from "@/lib/services/dividends";
import { getStockDetailSnapshot, loadSerializedFifoBuckets } from "@/lib/services/holdings";
import {
  createPortfolio,
  createTransaction,
  deleteTransaction,
  listEnrichedTransactions,
  updateTransaction,
} from "@/lib/services/ledger";

const migrationsFolder = path.join(
  import.meta.dirname,
  "..",
  "..",
  "db",
  "migrations",
);

describe("Automatic Dividend Discovery, Withholding Tax & Deduplication", () => {
  let db: Database;

  beforeEach(async () => {
    clearDividendSyncCaches();
    const client = new PGlite();
    const pgliteDb = drizzle(client, { schema });
    await migrate(pgliteDb, { migrationsFolder });
    db = pgliteDb as unknown as Database;
  });

  it("applies 0% withholding tax to SGX (.SI/SGD) and 30% to US/USD holdings including TCEHY", () => {
    expect(
      resolveDividendWithholdingTaxPercent({
        symbol: "ES3.SI",
        currency: "SGD",
        exchangeCode: "SES",
      }),
    ).toBe(0);
    expect(
      resolveDividendWithholdingTaxPercent({
        symbol: "A17U.SI",
        currency: "SGD",
      }),
    ).toBe(0);
    expect(
      resolveDividendWithholdingTaxPercent({
        symbol: "MSFT",
        currency: "USD",
        exchangeCode: "NMS",
      }),
    ).toBe(30);
    expect(
      resolveDividendWithholdingTaxPercent({
        symbol: "TCEHY",
        currency: "USD",
        exchangeCode: "PNK",
      }),
    ).toBe(30);
  });

  it("syncs eligible dividends with 30% US / 0% SGX tax, prevents double-counting, updates on trade edits, and renders Dividends Received tab", async () => {
    const sgPortfolio = await createPortfolio(
      { name: "SG Portfolio", type: "holdings" },
      db,
    );
    const usPortfolio = await createPortfolio(
      { name: "US Portfolio", type: "holdings" },
      db,
    );

    // 1. Buy 100 ES3.SI on 2025-02-05 @ S$3.10
    const es3Buy = await createTransaction(
      {
        portfolioId: sgPortfolio.id,
        symbol: "ES3.SI",
        instrumentName: "SPDR STI ETF",
        exchangeCode: "SES",
        currency: "SGD",
        type: "Buy",
        quantity: "100",
        price: "3.10",
        commission: "0",
        date: "2025-02-05",
        time: "10:00:00",
      },
      db,
    );

    // 2. Buy 10 TCEHY on 2025-02-05 @ $37.50, then Sell All on 2026-01-21 @ $77.00
    await createTransaction(
      {
        portfolioId: usPortfolio.id,
        symbol: "TCEHY",
        instrumentName: "Tencent Holdings ADR",
        exchangeCode: "PNK",
        currency: "USD",
        type: "Buy",
        quantity: "10",
        price: "37.50",
        commission: "0",
        date: "2025-02-05",
        time: "10:00:00",
      },
      db,
    );
    await createTransaction(
      {
        portfolioId: usPortfolio.id,
        symbol: "TCEHY",
        currency: "USD",
        type: "Sell All",
        quantity: "0",
        price: "77.00",
        commission: "0",
        date: "2026-01-21",
        time: "10:00:00",
      },
      db,
    );

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("frankfurter")) {
        return new Response(
          JSON.stringify({
            amount: 1,
            base: "USD",
            start_date: "2025-01-01",
            end_date: "2026-11-16",
            rates: {
              "2025-02-05": { SGD: 1.35 },
              "2025-05-19": { SGD: 1.34 },
              "2026-01-21": { SGD: 1.36 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.includes("ES3.SI") && url.includes("events=div")) {
        // Includes an adjacent-day duplicate (2025-08-12 and 2025-08-13) to verify deduplication
        return new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: {
                    symbol: "ES3.SI",
                    currency: "SGD",
                    exchangeTimezoneName: "Asia/Singapore",
                  },
                  events: {
                    dividends: {
                      "1": {
                        date: Math.floor(
                          new Date("2025-02-12T04:00:00Z").getTime() / 1000,
                        ),
                        amount: 0.091,
                      },
                      "2": {
                        date: Math.floor(
                          new Date("2025-08-12T04:00:00Z").getTime() / 1000,
                        ),
                        amount: 0.089,
                      },
                      "3": {
                        date: Math.floor(
                          new Date("2025-08-13T04:00:00Z").getTime() / 1000,
                        ),
                        amount: 0.089,
                      },
                    },
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.includes("TCEHY") && url.includes("events=div")) {
        // Two dividends: 2025-05-19 (eligible, held 10 sh) and 2026-05-18 (ineligible, Sold All on 2026-01-21)
        return new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: {
                    symbol: "TCEHY",
                    currency: "USD",
                    exchangeTimezoneName: "America/New_York",
                  },
                  events: {
                    dividends: {
                      "1": {
                        date: Math.floor(
                          new Date("2025-05-19T14:00:00Z").getTime() / 1000,
                        ),
                        amount: 0.573,
                      },
                      "2": {
                        date: Math.floor(
                          new Date("2026-05-18T14:00:00Z").getTime() / 1000,
                        ),
                        amount: 0.677,
                      },
                    },
                  },
                },
              ],
            },
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
                  currency: "SGD",
                  regularMarketPrice: 3.5,
                  chartPreviousClose: 3.48,
                },
                timestamp: [
                  Math.floor(new Date("2025-02-05T04:00:00Z").getTime() / 1000),
                  Math.floor(new Date("2026-11-16T04:00:00Z").getTime() / 1000),
                ],
                indicators: {
                  quote: [
                    {
                      open: [3.1, 3.5],
                      high: [3.1, 3.5],
                      low: [3.1, 3.5],
                      close: [3.1, 3.5],
                      volume: [1000, 1000],
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

    // First sync: should insert 2 ES3.SI dividends (0% tax) and 1 TCEHY dividend (30% tax)
    const firstSync = await syncPortfolioDividends({
      db,
      fetchImpl: mockFetch,
      now: new Date("2026-11-16T12:00:00Z"),
    });
    expect(firstSync.insertedCount).toBe(3);
    expect(firstSync.updatedCount).toBe(0);
    expect(firstSync.deletedCount).toBe(0);

    // Second sync: idempotent -> 0 new inserts, 0 updates, 0 deletes
    const secondSync = await syncPortfolioDividends({
      db,
      fetchImpl: mockFetch,
      now: new Date("2026-11-16T12:00:00Z"),
    });
    expect(secondSync.insertedCount).toBe(0);
    expect(secondSync.updatedCount).toBe(0);

    // Check serialized FIFO buckets:
    // ES3.SI: 100 * (0.091 + 0.089) = S$18.00 gross, 0% tax -> S$18.00 net
    // TCEHY: 10 * 0.573 = $5.73 gross, 30% tax (-$1.719) -> $4.011 net
    const { buckets } = await loadSerializedFifoBuckets({ db });
    const es3Bucket = buckets.find((b) => b.symbol === "ES3.SI")!;
    const tcehyBucket = buckets.find((b) => b.symbol === "TCEHY")!;

    expect(Number(es3Bucket.dividendsReceived)).toBeCloseTo(18.0, 4);
    expect(es3Bucket.dividends).toHaveLength(2);
    expect(Number(es3Bucket.dividends![0].withholdingTaxPercent)).toBe(0);

    expect(Number(tcehyBucket.dividendsReceived)).toBeCloseTo(4.011, 4);
    expect(tcehyBucket.dividends).toHaveLength(1);
    expect(Number(tcehyBucket.dividends![0].grossAmount)).toBeCloseTo(5.73, 4);
    expect(Number(tcehyBucket.dividends![0].withholdingTaxPercent)).toBe(30);
    expect(Number(tcehyBucket.dividends![0].withholdingTaxAmount)).toBeCloseTo(
      1.719,
      4,
    );
    expect(Number(tcehyBucket.dividends![0].netAmount)).toBeCloseTo(4.011, 4);

    // Editing ES3.SI buy quantity from 100 -> 200 shares updates auto-dividends automatically
    await updateTransaction(
      es3Buy.id,
      {
        portfolioId: sgPortfolio.id,
        symbol: "ES3.SI",
        type: "Buy",
        quantity: "200",
        price: "3.10",
        commission: "0",
        date: "2025-02-05",
        time: "10:00:00",
      },
      db,
    );
    const thirdSync = await syncPortfolioDividends({
      db,
      fetchImpl: mockFetch,
      now: new Date("2026-11-16T12:00:00Z"),
    });
    expect(thirdSync.updatedCount).toBe(2);

    const { buckets: updatedBuckets } = await loadSerializedFifoBuckets({ db });
    const updatedEs3 = updatedBuckets.find((b) => b.symbol === "ES3.SI")!;
    expect(Number(updatedEs3.dividendsReceived)).toBeCloseTo(36.0, 4);

    // Verify StockDetailView renders the new "Dividends Received" tab beside Closed Trades
    const detailSnap = await getStockDetailSnapshot("ES3.SI", db);
    expect(detailSnap).not.toBeNull();
    const detailHtml = renderToStaticMarkup(
      createElement(StockDetailView, detailSnap!),
    );
    expect(detailHtml).toContain("Dividends Received (2)");
    expect(detailHtml).toContain("Closed Trades (0)");

    // Verify Market Value in analytics stays open share value (200 * 3.50 = 700), while Dividends flow into return/profit
    const analytics = await computePortfolioAnalytics({
      portfolioId: "all",
      currency: "SGD",
      includeBenchmarks: false,
      includeFundamentals: false,
      cacheOnly: false,
      fetchImpl: mockFetch,
      db,
      now: new Date("2026-11-16T12:00:00Z"),
    });
    expect(Number(analytics.summary.totalMarketValueInBase)).toBe(700);
    expect(Number(analytics.summary.totalDividendsInBase)).toBeGreaterThan(36);

    // Deleting the ES3.SI buy removes its auto-dividends on next sync
    await deleteTransaction(es3Buy.id, db);
    const fourthSync = await syncPortfolioDividends({
      db,
      fetchImpl: mockFetch,
      now: new Date("2026-11-16T12:00:00Z"),
    });
    expect(fourthSync.deletedCount).toBe(2);
    const remainingDivTxs = (await listEnrichedTransactions({}, db)).filter(
      (t) => t.symbol === "ES3.SI" && t.type === "Dividend",
    );
    expect(remainingDivTxs).toHaveLength(0);
  });
});
