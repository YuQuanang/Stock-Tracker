import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import {
  computeLedgerSummaries,
  createCorporateSplit,
  createPortfolio,
  createTransaction,
  deleteTransaction,
  getEnrichedTransactionById,
  LedgerUserError,
  listEnrichedTransactions,
  updateTransaction,
} from "@/lib/services/ledger";

const migrationsFolder = path.join(import.meta.dirname, "..", "..", "db", "migrations");

describe("Ledger service CRUD and FIFO rollback invariants", () => {
  let db: Database;

  beforeEach(async () => {
    const client = new PGlite();
    const pgliteDb = drizzle(client, { schema });
    await migrate(pgliteDb, { migrationsFolder });
    db = pgliteDb as unknown as Database;
  });

  it("creates independent portfolios, records transactions, and computes summaries", async () => {
    const usStocks = await createPortfolio(
      { name: "US Stocks", type: "holdings", defaultCurrency: "USD" },
      db,
    );
    const current = await createPortfolio(
      { name: "Current", type: "holdings", defaultCurrency: "USD" },
      db,
    );

    // Same symbol INTC in two independent portfolios (section 4 & 7.8)
    await createTransaction(
      {
        portfolioId: usStocks.id,
        symbol: "INTC",
        instrumentName: "Intel Corporation",
        type: "Buy",
        quantity: "5",
        price: "50.58",
        commission: "0",
        date: "2021-11-03",
        time: "08:13:00",
      },
      db,
    );
    await createTransaction(
      {
        portfolioId: current.id,
        symbol: "INTC",
        type: "Buy",
        quantity: "10",
        price: "30",
        date: "2025-01-10",
      },
      db,
    );

    const summary = await computeLedgerSummaries(undefined, db);
    expect(summary.positions).toHaveLength(2);
    const usIntc = summary.positions.find((p) => p.portfolioId === usStocks.id);
    const curIntc = summary.positions.find((p) => p.portfolioId === current.id);
    expect(usIntc?.sharesHeld).toBe("5");
    expect(curIntc?.sharesHeld).toBe("10");
  });

  it("rolls back edits or deletes that would turn a later Sell into an oversell", async () => {
    const sgStocks = await createPortfolio(
      { name: "SG Stocks", type: "holdings", defaultCurrency: "SGD" },
      db,
    );

    const buy1 = await createTransaction(
      {
        portfolioId: sgStocks.id,
        symbol: "ES3.SI",
        type: "Buy",
        quantity: "100",
        price: "3.20",
        currency: "SGD",
        date: "2023-01-10",
      },
      db,
    );

    await createTransaction(
      {
        portfolioId: sgStocks.id,
        symbol: "ES3.SI",
        type: "Sell",
        quantity: "80",
        price: "3.40",
        currency: "SGD",
        date: "2023-06-10",
      },
      db,
    );

    // Deleting buy1 would leave the 80-share sell on 2023-06-10 with 0 shares held -> must reject & roll back!
    await expect(deleteTransaction(buy1.id, db)).rejects.toThrow(LedgerUserError);

    // Reducing buy1 to 50 shares also causes an oversell on 2023-06-10 -> must reject & roll back!
    await expect(
      updateTransaction(
        buy1.id,
        {
          portfolioId: sgStocks.id,
          symbol: "ES3.SI",
          type: "Buy",
          quantity: "50",
          price: "3.20",
          currency: "SGD",
          date: "2023-01-10",
        },
        db,
      ),
    ).rejects.toThrow(/only 50 shares were held/i);

    // Original ledger remains intact with 20 shares still held.
    const rows = await listEnrichedTransactions({ portfolioId: sgStocks.id }, db);
    expect(rows).toHaveLength(2);
    const summary = await computeLedgerSummaries(sgStocks.id, db);
    expect(summary.positions[0]?.sharesHeld).toBe("20");
  });

  it("blocks adding transactions to a watchlist portfolio", async () => {
    const watchlist = await createPortfolio(
      { name: "My Portfolio", type: "watchlist", defaultCurrency: "USD" },
      db,
    );

    await expect(
      createTransaction(
        {
          portfolioId: watchlist.id,
          symbol: "AAPL",
          type: "Buy",
          quantity: "1",
          price: "180",
          date: "2024-01-05",
        },
        db,
      ),
    ).rejects.toThrow(/watchlist/i);
  });

  it("applies manual stock splits and allows post-split share sales", async () => {
    const us = await createPortfolio(
      { name: "US", type: "holdings", defaultCurrency: "USD" },
      db,
    );

    await createTransaction(
      {
        portfolioId: us.id,
        symbol: "NVDA",
        type: "Buy",
        quantity: "3",
        price: "1000",
        date: "2024-05-01",
      },
      db,
    );

    await createCorporateSplit(
      {
        symbol: "NVDA",
        exDate: "2024-06-10",
        ratioNumerator: 10,
        ratioDenominator: 1,
      },
      db,
    );

    // After 10:1 split, 30 shares are held, so selling 15 succeeds.
    await createTransaction(
      {
        portfolioId: us.id,
        symbol: "NVDA",
        type: "Sell",
        quantity: "15",
        price: "130",
        date: "2024-07-01",
      },
      db,
    );

    const summary = await computeLedgerSummaries(us.id, db);
    expect(summary.positions[0]?.sharesHeld).toBe("15");
    expect(summary.positions[0]?.openCostBasis).toBe("1500");
    expect(summary.positions[0]?.realizedPnl).toBe("450");
  });

  it("Step (e): persists full trade-entry snapshot fields, exact SGD total, UTC timestamp, and manual edit flags", async () => {
    const us = await createPortfolio(
      { name: "US Stocks", type: "holdings", defaultCurrency: "USD" },
      db,
    );
    const sg = await createPortfolio(
      { name: "SG Stocks", type: "holdings", defaultCurrency: "SGD" },
      db,
    );

    // 1. Auto-filled USD stock transaction with live quote + Frankfurter FX snapshot
    const createdUsd = await createTransaction(
      {
        portfolioId: us.id,
        symbol: "AAPL",
        instrumentName: "Apple Inc.",
        exchangeCode: "NMS",
        type: "Buy",
        quantity: "5",
        price: "342.37",
        currency: "USD",
        date: "2026-11-07",
        time: "13:05:00",
        offset: "+0800",
        priceAsOf: "2026-11-06T21:00:00.000Z",
        priceStatus: "last_close",
        fxRateToSgd: "1.2816",
        fxAsOf: "2026-11-07T04:00:00.000Z",
        fxSource: "frankfurter",
        isManualPrice: false,
        isManualFxRate: false,
      },
      db,
    );

    const savedUsd = await getEnrichedTransactionById(createdUsd.id, db);
    expect(savedUsd).toMatchObject({
      symbol: "AAPL",
      instrumentName: "Apple Inc.",
      exchangeCode: "NMS",
      quantity: "5",
      price: "342.37",
      currency: "USD",
      priceAsOf: "2026-11-06T21:00:00.000Z",
      priceStatus: "last_close",
      fxRateToSgd: "1.2816",
      fxAsOf: "2026-11-07T04:00:00.000Z",
      fxSource: "frankfurter",
      // 5 * 342.37 * 1.2816 = 2193.90696 (exact Decimal, zero float drift)
      totalCostSgd: "2193.90696",
      // 13:05:00 Asia/Singapore (+0800) == 05:05:00.000Z UTC
      executedAt: "2026-11-07T05:05:00.000Z",
      localDate: "2026-11-07",
      localTime: "13:05:00",
      isManualPrice: false,
      isManualFxRate: false,
      purchaseFxRate: "1.2816",
      purchaseFxCurrencies: "USD/SGD",
    });

    // 2. Native SGD stock locks rate = 1 and computes exact SGD cost without FX fetch
    const createdSgd = await createTransaction(
      {
        portfolioId: sg.id,
        symbol: "ES3.SI",
        instrumentName: "SPDR Straits Times Index ETF",
        exchangeCode: "SES",
        type: "Buy",
        quantity: "100",
        price: "3.82",
        currency: "SGD",
        date: "2026-11-07",
        time: "13:10:00",
        priceAsOf: "2026-11-06T09:04:00.000Z",
        priceStatus: "last_close",
      },
      db,
    );

    const savedSgd = await getEnrichedTransactionById(createdSgd.id, db);
    expect(savedSgd).toMatchObject({
      symbol: "ES3.SI",
      instrumentName: "SPDR Straits Times Index ETF",
      exchangeCode: "SES",
      currency: "SGD",
      fxRateToSgd: "1",
      fxSource: "native-sgd",
      totalCostSgd: "382",
      isManualPrice: false,
      isManualFxRate: false,
    });

    // 3. Manual price & manual FX flags + graceful save when FX fetch failed (no guessed value)
    const manualUsd = await createTransaction(
      {
        portfolioId: us.id,
        symbol: "MSFT",
        instrumentName: "Microsoft Corporation",
        exchangeCode: "NMS",
        type: "Buy",
        quantity: "2",
        price: "420.50",
        currency: "USD",
        date: "2026-11-07",
        time: "13:15:00",
        fxRateToSgd: "1.3000",
        isManualPrice: true,
        isManualFxRate: true,
      },
      db,
    );

    const savedManual = await getEnrichedTransactionById(manualUsd.id, db);
    expect(savedManual).toMatchObject({
      isManualPrice: true,
      isManualFxRate: true,
      priceStatus: "manual",
      priceAsOf: null,
      fxSource: "manual",
      fxRateToSgd: "1.3",
      totalCostSgd: "1093.3",
    });

    const missingFxUsd = await createTransaction(
      {
        portfolioId: us.id,
        symbol: "GOOGL",
        instrumentName: "Alphabet Inc.",
        exchangeCode: "NMS",
        type: "Buy",
        quantity: "1",
        price: "180.00",
        currency: "USD",
        date: "2026-11-07",
        time: "13:20:00",
        fxRateToSgd: null,
        isManualPrice: true,
      },
      db,
    );
    const savedMissingFx = await getEnrichedTransactionById(missingFxUsd.id, db);
    expect(savedMissingFx?.fxRateToSgd).toBeNull();
    expect(savedMissingFx?.totalCostSgd).toBeNull();
  });
});

