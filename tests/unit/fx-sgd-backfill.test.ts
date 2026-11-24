import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryTestDatabase, type Database } from "@/db/client";
import { toDecimal, toDecimalString, ZERO } from "@/lib/finance";
import {
  commitCsvImport,
  exportMspCsvFromDb,
} from "@/lib/services/csv-import-export";
import { backfillMissingTransactionSgdTotals } from "@/lib/services/fx-sgd";
import {
  createCorporateSplit,
  createPortfolio,
  createTransaction,
  listEnrichedTransactions,
} from "@/lib/services/ledger";

const fixturePath = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "MSP-Portfolios-2026-11-07.csv",
);
const fixtureCsv = fs.readFileSync(fixturePath, "utf8");

/**
 * Deterministic business-day USD -> SGD rate generator (`1.3000` + deterministic
 * offset per calendar day, skipping Saturdays and Sundays just like real ECB
 * Frankfurter time-series responses).
 */
function deterministicBusinessDayRate(isoDate: string): number {
  const [year, month, day] = isoDate.split("-").map(Number);
  const basisPoints = ((year - 2020) * 37 + month * 11 + day * 3) % 900;
  return Number((1.28 + basisPoints / 10000).toFixed(4));
}

function buildMockFrankfurterRangeFetch(): {
  fetchImpl: typeof fetch;
  calls: string[];
  expectedRateForDate: (isoDate: string) => string;
} {
  const calls: string[] = [];
  const publishedRates = new Map<string, number>();

  function populateRange(startIso: string, endIso: string): Record<string, { SGD: number }> {
    const [sy, sm, sd] = startIso.split("-").map(Number);
    const [ey, em, ed] = endIso.split("-").map(Number);
    const cursor = new Date(Date.UTC(sy, sm - 1, sd));
    const end = new Date(Date.UTC(ey, em - 1, ed));

    const rates: Record<string, { SGD: number }> = {};
    while (cursor.getTime() <= end.getTime()) {
      const dow = cursor.getUTCDay();
      if (dow !== 0 && dow !== 6) {
        const y = cursor.getUTCFullYear();
        const m = String(cursor.getUTCMonth() + 1).padStart(2, "0");
        const d = String(cursor.getUTCDate()).padStart(2, "0");
        const iso = `${y}-${m}-${d}`;
        const rate = deterministicBusinessDayRate(iso);
        rates[iso] = { SGD: rate };
        publishedRates.set(iso, rate);
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return rates;
  }

  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);

    const rangeMatch = url.match(/\/v1\/(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/);
    if (!rangeMatch) {
      return new Response("Not Found", { status: 404 });
    }

    const startDate = rangeMatch[1];
    const endDate = rangeMatch[2];
    const rates = populateRange(startDate, endDate);

    return new Response(
      JSON.stringify({
        amount: 1,
        base: "USD",
        start_date: startDate,
        end_date: endDate,
        rates,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  function expectedRateForDate(isoDate: string): string {
    const [y, m, d] = isoDate.split("-").map(Number);
    const cursor = new Date(Date.UTC(y, m - 1, d));
    for (let step = 0; step <= 10; step += 1) {
      const cy = cursor.getUTCFullYear();
      const cm = String(cursor.getUTCMonth() + 1).padStart(2, "0");
      const cd = String(cursor.getUTCDate()).padStart(2, "0");
      const candidate = `${cy}-${cm}-${cd}`;
      const found = publishedRates.get(candidate);
      if (found !== undefined) {
        return toDecimalString(toDecimal(found), 10);
      }
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    throw new Error(`No published mock FX rate found near ${isoDate}`);
  }

  return { fetchImpl, calls, expectedRateForDate };
}

describe("Historical USD -> SGD Total Calculation Across Imported & Manual Transactions", () => {
  let db: Database;

  beforeEach(async () => {
    db = await createInMemoryTestDatabase();
  });

  it("calculates fxRateToSgd and totalCostSgd for all 220 imported MSP CSV transactions using trade-date FX while preserving 100% lossless export", async () => {
    const mockFx = buildMockFrankfurterRangeFetch();

    const commit = await commitCsvImport(
      {
        filename: "MSP-Portfolios-2026-11-07.csv",
        csvText: fixtureCsv,
        duplicateMode: "skip",
        fetchImpl: mockFx.fetchImpl,
      },
      db,
    );

    expect(commit.rowCounts.transactionsImported).toBe(220);
    expect(mockFx.calls).toHaveLength(1);

    const allTransactions = await listEnrichedTransactions({}, db);
    expect(allTransactions).toHaveLength(220);

    // Every single one of the 220 imported transactions must have non-null fxRateToSgd & totalCostSgd
    const missingTotal = allTransactions.filter((tx) => tx.totalCostSgd === null);
    const missingFx = allTransactions.filter((tx) => tx.fxRateToSgd === null);
    expect(missingTotal).toHaveLength(0);
    expect(missingFx).toHaveLength(0);

    // Verify native SGD transactions have rate = 1 and exact quantity * price totals
    const sgdRows = allTransactions.filter((tx) => tx.currency === "SGD");
    expect(sgdRows.length).toBeGreaterThan(60);
    for (const row of sgdRows) {
      expect(row.fxRateToSgd).toBe("1");
      expect(row.fxSource).toBe("native-sgd");
    }

    // Verify USD Buy, Sell, and Dividend rows use the exact historical date FX rate
    // (including weekend trades stepping back to the nearest Friday business day)
    const usdNonSellAll = allTransactions.filter(
      (tx) => tx.currency === "USD" && tx.type !== "Sell All",
    );
    expect(usdNonSellAll.length).toBeGreaterThan(130);

    for (const row of usdNonSellAll) {
      const expectedRate = mockFx.expectedRateForDate(row.localDate);
      expect(row.fxRateToSgd).toBe(expectedRate);
      expect(row.fxSource).toBe("frankfurter");

      const expectedTotal =
        row.type === "Dividend"
          ? toDecimal(row.quantity).mul(toDecimal(expectedRate))
          : toDecimal(row.quantity)
              .mul(toDecimal(row.price))
              .mul(toDecimal(expectedRate));

      expect(row.totalCostSgd).toBe(toDecimalString(expectedTotal, 6));
      // Source CSV had empty Purchase Exchange Rate — must remain null for lossless MSP export!
      expect(row.purchaseFxRate).toBeNull();
      expect(row.purchaseFxCurrencies).toBeNull();
    }

    // Verify all 8 Sell All rows have strictly positive SGD proceeds resolved from FIFO shares
    const sellAllRows = allTransactions.filter((tx) => tx.type === "Sell All");
    expect(sellAllRows).toHaveLength(8);
    for (const row of sellAllRows) {
      expect(row.quantity).toBe("0");
      expect(toDecimal(row.totalCostSgd ?? "0").gt(ZERO)).toBe(true);
    }

    // Lossless MSP CSV export must STILL match the original file 100% byte-for-byte
    const exportedMsp = await exportMspCsvFromDb({}, db);
    expect(exportedMsp.content).toBe(fixtureCsv);
  });

  it("gracefully flags offline imports without fabricating rates and backfills 100% once online", async () => {
    const failingFetch: typeof fetch = async () => {
      throw new Error("Simulated offline network");
    };

    const offlineCommit = await commitCsvImport(
      {
        filename: "MSP-Portfolios-2026-11-07.csv",
        csvText: fixtureCsv,
        duplicateMode: "skip",
        fetchImpl: failingFetch,
      },
      db,
    );

    expect(
      offlineCommit.warnings.some((w) => w.kind === "missing_fx"),
    ).toBe(true);

    const afterOffline = await listEnrichedTransactions({}, db);
    // Native SGD rows (including SGD Sell All rows!) already have exact SGD totals offline
    const offlineSgdMissing = afterOffline.filter(
      (tx) => tx.currency === "SGD" && tx.totalCostSgd === null,
    );
    expect(offlineSgdMissing).toHaveLength(0);

    // USD rows remain null (Rule 17: never fabricate FX rates)
    const offlineUsdMissing = afterOffline.filter(
      (tx) => tx.currency === "USD" && tx.totalCostSgd === null,
    );
    expect(offlineUsdMissing).toHaveLength(142);

    // Now reconnect and run backfillMissingTransactionSgdTotals
    const mockFx = buildMockFrankfurterRangeFetch();
    const backfill = await backfillMissingTransactionSgdTotals({
      db,
      fetchImpl: mockFx.fetchImpl,
    });

    expect(backfill.fetchFailed).toBe(false);
    expect(backfill.updatedCount).toBe(142);

    const afterBackfill = await listEnrichedTransactions({}, db);
    expect(afterBackfill.filter((tx) => tx.totalCostSgd === null)).toHaveLength(0);
    expect(afterBackfill.filter((tx) => tx.fxRateToSgd === null)).toHaveLength(0);
  });

  it("computes exact Sell All totalCostSgd across splits for manual transactions", async () => {
    const portfolio = await createPortfolio(
      { name: "Growth USD", type: "holdings", defaultCurrency: "USD" },
      db,
    );

    const buyTx = await createTransaction(
      {
        portfolioId: portfolio.id,
        symbol: "NVDA",
        instrumentName: "NVIDIA Corp.",
        exchangeCode: "NASDAQ",
        type: "Buy",
        quantity: "10",
        price: "120",
        date: "2024-05-15",
        time: "21:30:00",
        currency: "USD",
        fxRateToSgd: "1.3450",
        fxSource: "frankfurter",
      },
      db,
    );
    // 10 * 120 * 1.3450 = 1614
    expect(toDecimal(buyTx.totalCostSgd ?? "0").toFixed(2)).toBe("1614.00");

    // 10-for-1 stock split on 2024-06-10 -> open position becomes 100 shares
    await createCorporateSplit(
      {
        symbol: "NVDA",
        exDate: "2024-06-10",
        ratioNumerator: 10,
        ratioDenominator: 1,
      },
      db,
    );

    const sellAllTx = await createTransaction(
      {
        portfolioId: portfolio.id,
        symbol: "NVDA",
        instrumentName: "NVIDIA Corp.",
        exchangeCode: "NASDAQ",
        type: "Sell All",
        quantity: "0",
        price: "140",
        date: "2025-11-05",
        time: "22:00:00",
        currency: "USD",
        fxRateToSgd: "1.3020",
        fxSource: "frankfurter",
      },
      db,
    );

    // 100 split-adjusted shares * $140 * 1.3020 = S$18,228.00
    expect(toDecimal(sellAllTx.totalCostSgd ?? "0").toFixed(2)).toBe("18228.00");
  });
});
