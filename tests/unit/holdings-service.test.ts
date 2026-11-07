import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import { toDecimal } from "@/lib/finance";
import { formatCompactMoney, formatCompactNumber } from "@/lib/format";
import { buildValuedHoldings } from "@/lib/holdings/valuation";
import type { ResolvedInstrumentQuote } from "@/lib/market-data/batch-quotes";
import { commitCsvImport } from "@/lib/services/csv-import-export";
import { loadSerializedFifoBuckets } from "@/lib/services/holdings";
import {
  listPortfolios,
  updateInstrumentOverrides,
} from "@/lib/services/ledger";

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

function makeQuote(params: {
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

const offlineStubFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ rates: { "2020-01-02": { SGD: 1.345 } } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("Holdings FIFO Buckets & Client/Server Valuation Mapper", () => {
  let db: Database;

  beforeEach(async () => {
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

  it("closes a symbol across EVERY portfolio on Sell All so zero open shares or unrealized P&L remain", async () => {
    const portfolios = await listPortfolios(db);
    const usStocks = portfolios.find((p) => p.name === "US Stocks");
    const currentPortfolio = portfolios.find((p) => p.name === "Current");
    expect(usStocks).toBeDefined();
    expect(currentPortfolio).toBeDefined();

    const { buckets, baseCurrency } = await loadSerializedFifoBuckets({ db });
    expect(baseCurrency).toBe("SGD");

    // Watchlist ("My Portfolio") must never appear in holdings FIFO buckets
    expect(buckets.some((b) => b.portfolioName === "My Portfolio")).toBe(false);

    const quotes: Record<string, ResolvedInstrumentQuote> = {
      PLTR: makeQuote({
        symbol: "PLTR",
        currency: "USD",
        price: "160.38",
        previousClose: "155.00",
      }),
      INTC: makeQuote({
        symbol: "INTC",
        currency: "USD",
        price: "25.00",
        previousClose: "24.00",
      }),
      TCEHY: makeQuote({
        symbol: "TCEHY",
        currency: "USD",
        price: "60.00",
        previousClose: "59.00",
      }),
      AMZN: makeQuote({
        symbol: "AMZN",
        currency: "USD",
        price: "245.00",
        previousClose: "240.00",
      }),
      NVDA: makeQuote({
        symbol: "NVDA",
        currency: "USD",
        price: "145.00",
        previousClose: "140.00",
      }),
      "D05.SI": makeQuote({
        symbol: "D05.SI",
        currency: "SGD",
        price: "42.50",
        previousClose: "42.00",
      }),
    };

    // 1. PLTR had 19 shares bought in `US Stocks` (2021–2022), 10 shares in
    //    `Current` (2025-02-05), and `Sell All @ $94` on 2025-04-22 in `Current`.
    //    Therefore PLTR must have 0 open shares and NO unrealized P&L in
    //    `US Stocks`, in `Current`, and in `All portfolios`.
    for (const scopeId of [usStocks!.id, currentPortfolio!.id, "all"]) {
      const valuation = buildValuedHoldings({
        buckets,
        portfolioFilterId: scopeId,
        quotes,
        usdToSgdRate: "1.3200",
        baseCurrency: "SGD",
      });

      for (const sym of ["PLTR", "INTC", "TCEHY"]) {
        const row = valuation.rows.find((r) => r.symbol === sym);
        expect(row).toBeDefined();
        expect(row!.isOpenPosition).toBe(false);
        expect(row!.isClosedPosition).toBe(true);
        expect(row!.sharesHeld).toBe("0");
        expect(row!.marketValue).toBe("0");
        expect(row!.unrealizedPnl).toBe("0");
        expect(row!.unrealizedPnlPercent).toBeNull();
      }
    }

    // Verify PLTR's realized P&L across all 29 shares sold at $94.00:
    // US Stocks cost basis = (10*19.78) + (3*18.15 + 1.14) + (3*14.5) + (3*14.5) = 340.39
    // US Stocks proceeds   = 19 * 94 = 1786.00 -> realized P&L = 1445.61
    // Current cost basis   = 10 * 0 = 0, proceeds = 10 * 94 = 940.00 -> realized P&L = 940.00
    // Combined realized P&L = 2385.61
    const allValuation = buildValuedHoldings({
      buckets,
      portfolioFilterId: "all",
      quotes,
      usdToSgdRate: "1.3200",
      baseCurrency: "SGD",
    });
    const pltrAll = allValuation.rows.find((r) => r.symbol === "PLTR");
    expect(pltrAll).toBeDefined();
    expect(pltrAll!.realizedPnl).toBe("2385.61");
    expect(pltrAll!.dividendsReceived).toBe("0.18");
    expect(pltrAll!.totalReturn).toBe("2385.79");

    // 2. AMZN had a `Sell All` on 2026-04-21 and then a NEW `Buy 5 @ $240` on
    //    2026-06-19 -> only the 5 post-Sell-All shares remain open!
    const amznAll = allValuation.rows.find((r) => r.symbol === "AMZN");
    expect(amznAll).toBeDefined();
    expect(amznAll!.isOpenPosition).toBe(true);
    expect(amznAll!.sharesHeld).toBe("5");
    expect(amznAll!.costBasis).toBe("1200");

    // Portfolio weights across priced open positions sum to 100%
    const pricedWeights = allValuation.rows
      .filter((r) => r.isOpenPosition && r.weightPercent !== null)
      .map((r) => toDecimal(r.weightPercent!));
    expect(pricedWeights.length).toBeGreaterThan(0);
    const totalWeight = pricedWeights.reduce(
      (acc, w) => acc.plus(w),
      toDecimal(0),
    );
    expect(totalWeight.minus(100).abs().lte("0.05")).toBe(true);
  });

  it("flags unpriced crypto positions honestly and values them once manual or worthless overrides are applied", async () => {
    const portfolios = await listPortfolios(db);
    const cryptoPortfolio = portfolios.find(
      (p) => p.name === "Crypto Portfolio",
    );
    expect(cryptoPortfolio).toBeDefined();

    const { buckets } = await loadSerializedFifoBuckets({ db });

    // Without overrides, open crypto positions (`HBAR-USD`, `ETH-SGD`) have no live quotes -> listed in `unpricedOpenSymbols`, marketValue = 0
    const initial = buildValuedHoldings({
      buckets,
      portfolioFilterId: cryptoPortfolio!.id,
      quotes: {},
      usdToSgdRate: "1.3200",
      baseCurrency: "SGD",
    });
    expect(initial.summary.unpricedOpenSymbols).toContain("HBAR-USD");
    expect(initial.summary.totalMarketValueInBase).toBe("0");

    // Mark HBAR-USD as delisted/worthless ($0) via updateInstrumentOverrides
    const [hbarInstr] = await db
      .select()
      .from(schema.instrument)
      .where(eq(schema.instrument.symbol, "HBAR-USD"));
    expect(hbarInstr).toBeDefined();

    await updateInstrumentOverrides(
      hbarInstr!.id,
      { isDelisted: true, manualPrice: null },
      db,
    );

    const { buckets: updatedBuckets } = await loadSerializedFifoBuckets({ db });
    const afterOverride = buildValuedHoldings({
      buckets: updatedBuckets,
      portfolioFilterId: cryptoPortfolio!.id,
      quotes: {},
      usdToSgdRate: "1.3200",
      baseCurrency: "SGD",
    });

    expect(afterOverride.summary.unpricedOpenSymbols).not.toContain("HBAR-USD");
    const hbarRow = afterOverride.rows.find((r) => r.symbol === "HBAR-USD");
    expect(hbarRow).toBeDefined();
    expect(hbarRow!.unitPrice).toBe("0");
    expect(hbarRow!.marketValue).toBe("0");
    expect(hbarRow!.freshnessLabel).toBe("Marked worthless ($0)");
    expect(hbarRow!.unrealizedPnlPercent).toBe("-100");
  });

  it("formats compact currency and trading volume cleanly", () => {
    expect(formatCompactNumber("45200000")).toContain("45.2");
    expect(formatCompactNumber(null)).toBe("—");
    expect(formatCompactMoney("3240000000000", "USD")).toMatch(/3\.24/);
    expect(formatCompactMoney(undefined, "SGD")).toBe("—");
  });
});
