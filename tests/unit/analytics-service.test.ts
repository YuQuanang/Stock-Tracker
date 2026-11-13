import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import {
  clearFxCache,
  clearHistoryCaches,
  clearQuoteCache,
} from "@/lib/market-data";
import { computePortfolioAnalytics } from "@/lib/services/analytics";
import { commitCsvImport } from "@/lib/services/csv-import-export";
import { getOrCreateSettings } from "@/lib/services/ledger";
import { deleteAllPortfolioData, updateSettings } from "@/lib/services/settings";

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

function buildMockDailySeries(basePrice: number): {
  timestamps: number[];
  closes: number[];
} {
  // Weekly points from 2020-01-03 through 2026-11-06 + final consecutive days
  const timestamps: number[] = [];
  const closes: number[] = [];
  const startMs = Date.UTC(2020, 0, 3, 16, 0, 0);
  const endMs = Date.UTC(2026, 10, 6, 16, 0, 0);
  const dayMs = 86_400_000;
  let step = 0;

  for (let ms = startMs; ms <= endMs; ms += dayMs) {
    const dt = new Date(ms);
    const dow = dt.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    // Slight realistic upward wave so volatility, beta, correlation & drawdown are non-degenerate
    const drift = 1 + step * 0.00045 + Math.sin(step / 9) * 0.025;
    timestamps.push(Math.floor(ms / 1000));
    closes.push(Number((basePrice * drift).toFixed(4)));
    step += 1;
  }
  return { timestamps, closes };
}

function createOfflineAnalyticsFetch(): typeof fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("api.frankfurter.dev")) {
      // Check if time series (`..`) vs single-date (`latest` or `YYYY-MM-DD`)
      const isRange = url.includes("..");
      if (isRange) {
        const rates: Record<string, { SGD: number }> = {};
        const startMs = Date.UTC(2020, 0, 2);
        const endMs = Date.UTC(2026, 10, 6);
        for (let ms = startMs; ms <= endMs; ms += 7 * 86_400_000) {
          const iso = new Date(ms).toISOString().slice(0, 10);
          rates[iso] = { SGD: 1.35 };
        }
        rates["2026-11-05"] = { SGD: 1.348 };
        rates["2026-11-06"] = { SGD: 1.35 };
        return new Response(
          JSON.stringify({ amount: 1, base: "USD", rates }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          amount: 1,
          base: "USD",
          date: "2026-11-06",
          rates: { SGD: 1.35 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.includes("finance.yahoo.com/v8/finance/chart/")) {
      const encodedSym = url.split("/chart/")[1]?.split("?")[0] ?? "AAPL";
      const sym = decodeURIComponent(encodedSym);
      const isSgd = sym.endsWith(".SI") || sym === "^STI";
      const basePrice =
        sym === "^GSPC"
          ? 3200
          : sym === "^IXIC"
            ? 9000
            : sym === "^DJI"
              ? 28000
              : sym === "^STI"
                ? 3100
                : isSgd
                  ? 3.2
                  : 42;
      const series = buildMockDailySeries(basePrice);
      const lastClose = series.closes[series.closes.length - 1] ?? basePrice;
      const prevClose = series.closes[series.closes.length - 2] ?? basePrice;

      return new Response(
        JSON.stringify({
          chart: {
            result: [
              {
                meta: {
                  symbol: sym,
                  longName: sym,
                  currency: isSgd ? "SGD" : "USD",
                  exchangeName: isSgd ? "SES" : "NMS",
                  regularMarketPrice: lastClose,
                  chartPreviousClose: prevClose,
                  fiftyTwoWeekHigh: lastClose * 1.08,
                  fiftyTwoWeekLow: basePrice * 0.85,
                  regularMarketVolume: 1_500_000,
                },
                timestamp: series.timestamps,
                indicators: {
                  quote: [
                    {
                      open: series.closes,
                      high: series.closes.map((c) => Number((c * 1.01).toFixed(4))),
                      low: series.closes.map((c) => Number((c * 0.99).toFixed(4))),
                      close: series.closes,
                      volume: series.closes.map(() => 1_000_000),
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

    return new Response(JSON.stringify({ error: "Not mocked" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("Analytics & Settings Services (Milestone 7)", () => {
  let db: Database;

  beforeEach(() => {
    clearQuoteCache();
    clearFxCache();
    clearHistoryCaches();
  });

  beforeEach(async () => {
    const client = new PGlite();
    db = drizzle(client, { schema }) as unknown as Database;
    await migrate(db as never, { migrationsFolder });
  });

  it("returns empty onboarding state when no transactions exist", async () => {
    const snapshot = await computePortfolioAnalytics({
      includeBenchmarks: false,
      includeFundamentals: false,
      db,
      now: new Date("2026-11-06T12:00:00.000Z"),
      fetchImpl: createOfflineAnalyticsFetch(),
    });

    expect(snapshot.accountHasNoTransactions).toBe(true);
    expect(snapshot.isEmpty).toBe(true);
    expect(snapshot.timeline.points).toHaveLength(0);
    expect(snapshot.performance.xirrPercent).toBeNull();
    expect(snapshot.performance.cumulativeTwrPercent).toBeNull();
    expect(snapshot.allocations.instrument).toHaveLength(0);
  });

  it("computes full multi-portfolio analytics, allocations, benchmarks (SGD & USD), and data quality on imported ledger", async () => {
    const fetchImpl = createOfflineAnalyticsFetch();
    await commitCsvImport(
      {
        filename: "MSP-Portfolios-2026-11-07.csv",
        csvText: fixtureCsv,
        duplicateMode: "replace",
        fetchImpl,
      },
      db,
    );

    const sgdSnapshot = await computePortfolioAnalytics({
      portfolioId: "all",
      currency: "SGD",
      benchmarks: ["^GSPC", "^STI"],
      includeBenchmarks: true,
      includeFundamentals: true,
      db,
      now: new Date("2026-11-06T12:00:00.000Z"),
      fetchImpl,
    });

    expect(sgdSnapshot.accountHasNoTransactions).toBe(false);
    expect(sgdSnapshot.isEmpty).toBe(false);
    expect(sgdSnapshot.scope.currency).toBe("SGD");
    expect(sgdSnapshot.timeline.points.length).toBeGreaterThan(200);
    expect(sgdSnapshot.performance.cumulativeTwrPercent).not.toBeNull();
    expect(sgdSnapshot.performance.xirrPercent).not.toBeNull();
    expect(sgdSnapshot.performance.volatilityPercent).not.toBeNull();
    expect(sgdSnapshot.performance.drawdown.maxDrawdownPercent).not.toBeNull();

    // Allocations sum to ~100% across open priced holdings
    const totalPct = sgdSnapshot.allocations.instrument.reduce(
      (sum, slice) => sum + Number(slice.percent),
      0,
    );
    expect(totalPct).toBeCloseTo(100, 0);

    // Dead/crypto symbols excluded from external fetches and disclosed in Data Quality
    expect(
      sgdSnapshot.dataQuality.some(
        (d) => d.kind === "crypto_excluded" || d.kind === "missing_price",
      ),
    ).toBe(true);

    // Benchmarks aligned cleanly in SGD
    const sp500Sgd = sgdSnapshot.benchmarks["^GSPC"];
    expect(sp500Sgd?.status).toBe("ok");
    expect(sp500Sgd?.comparisonCurrency).toBe("SGD");
    expect(sp500Sgd?.nativeCurrency).toBe("USD");
    expect(sp500Sgd?.displaySymbol).toBe("GSPC");
    expect(Number(sp500Sgd?.rebasedSeries[0]?.value)).toBe(100);
    expect(sp500Sgd?.sameCashFlows).not.toBeNull();
    expect(Number(sp500Sgd?.sameCashFlows?.totalDeposited)).toBeGreaterThan(0);
    expect(sp500Sgd?.betaVsPortfolio).not.toBeNull();
    expect(sp500Sgd?.correlationVsPortfolio).not.toBeNull();

    // Switching comparison currency to USD aligns STI (SGD -> USD) cleanly too
    const usdSnapshot = await computePortfolioAnalytics({
      portfolioId: "all",
      currency: "USD",
      benchmarks: ["^STI"],
      includeBenchmarks: true,
      includeFundamentals: false,
      db,
      now: new Date("2026-11-06T12:00:00.000Z"),
      fetchImpl,
    });
    expect(usdSnapshot.scope.currency).toBe("USD");
    expect(usdSnapshot.benchmarks["^STI"]?.comparisonCurrency).toBe("USD");
    expect(usdSnapshot.benchmarks["^STI"]?.nativeCurrency).toBe("SGD");
    expect(usdSnapshot.benchmarks["^STI"]?.status).toBe("ok");

    // Scoping to a single portfolio updates portfolioName & holdings cleanly
    const targetPortfolio = sgdSnapshot.portfolios.find(
      (p) => p.name === "US Stocks",
    );
    expect(targetPortfolio).toBeDefined();
    const scopedSnapshot = await computePortfolioAnalytics({
      portfolioId: targetPortfolio!.id,
      currency: "SGD",
      includeBenchmarks: false,
      includeFundamentals: false,
      db,
      now: new Date("2026-11-06T12:00:00.000Z"),
      fetchImpl,
    });
    expect(scopedSnapshot.scope.portfolioName).toBe("US Stocks");
    expect(scopedSnapshot.allocations.currency.map((c) => c.key)).toEqual([
      "USD",
    ]);
  }, 20_000);

  it("persists settings updates, validates inputs, recalculates dividend FX mode, and wipes data cleanly", async () => {
    const fetchImpl = createOfflineAnalyticsFetch();
    await commitCsvImport(
      {
        filename: "MSP-Portfolios-2026-11-07.csv",
        csvText: fixtureCsv,
        duplicateMode: "replace",
        fetchImpl,
      },
      db,
    );

    const updated = await updateSettings(
      {
        baseCurrency: "USD",
        riskFreeRate: "0.04",
        defaultBenchmark: "^IXIC",
        dividendMode: "shares",
        theme: "dark",
        gainColorScheme: "color-blind-safe",
        numberFormat: "en-US",
        dateFormat: "yyyy-MM-dd",
      },
      db,
    );
    expect(updated.baseCurrency).toBe("USD");
    expect(Number(updated.riskFreeRate)).toBeCloseTo(0.04, 6);
    expect(updated.defaultBenchmark).toBe("^IXIC");
    expect(updated.dividendMode).toBe("shares");
    expect(updated.gainColorScheme).toBe("color-blind-safe");

    await expect(
      updateSettings({ riskFreeRate: "0.9" }, db),
    ).rejects.toThrow("Risk-free rate");

    await deleteAllPortfolioData(db);

    const resetSettings = await getOrCreateSettings(db);
    expect(resetSettings.baseCurrency).toBe("SGD");
    expect(resetSettings.theme).toBe("system");

    const postDelete = await computePortfolioAnalytics({
      includeBenchmarks: false,
      db,
      now: new Date("2026-11-06T12:00:00.000Z"),
      fetchImpl,
    });
    expect(postDelete.accountHasNoTransactions).toBe(true);
    expect(postDelete.portfolios).toHaveLength(0);
  });
});
