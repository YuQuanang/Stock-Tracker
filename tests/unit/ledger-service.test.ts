import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryTestDatabase, type Database } from "@/db/client";
import {
  adjustPortfolioHolding,
  computeLedgerSummaries,
  createCorporateSplit,
  createPortfolio,
  createTransaction,
  deletePortfolio,
  deleteTransaction,
  getEnrichedTransactionById,
  getOrCreateSettings,
  LedgerUserError,
  listEnrichedTransactions,
  listPortfolios,
  resolveDefaultPortfolioId,
  updatePortfolio,
  updateTransaction,
} from "@/lib/services/ledger";
import { updateSettings } from "@/lib/services/settings";

describe("Ledger service CRUD and FIFO rollback invariants", () => {
  let db: Database;

  beforeEach(async () => {
    db = await createInMemoryTestDatabase();
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

  it("renames portfolios safely with validation and duplicate-name conflict checks", async () => {
    const us = await createPortfolio(
      { name: "US Stocks", type: "holdings", defaultCurrency: "USD" },
      db,
    );
    await createPortfolio(
      { name: "SG Stocks", type: "holdings", defaultCurrency: "SGD" },
      db,
    );

    const tx = await createTransaction(
      {
        portfolioId: us.id,
        symbol: "AAPL",
        type: "Buy",
        quantity: "5",
        price: "200",
        date: "2026-01-15",
      },
      db,
    );

    // Renaming updates returned portfolio & joined enriched transactions
    const renamed = await updatePortfolio(
      us.id,
      { name: "  US Growth  " },
      db,
    );
    expect(renamed.name).toBe("US Growth");
    const enriched = await getEnrichedTransactionById(tx.id, db);
    expect(enriched?.portfolioName).toBe("US Growth");

    // Saving the same name idempotently or with an empty patch succeeds
    const sameName = await updatePortfolio(us.id, { name: "US Growth" }, db);
    expect(sameName.name).toBe("US Growth");
    const noOp = await updatePortfolio(us.id, {}, db);
    expect(noOp.id).toBe(us.id);

    // Blank names reject with 400
    await expect(
      updatePortfolio(us.id, { name: "   " }, db),
    ).rejects.toThrow(/cannot be empty/i);

    // Renaming onto another existing portfolio rejects with 409 conflict
    await expect(
      updatePortfolio(us.id, { name: "SG Stocks" }, db),
    ).rejects.toMatchObject({ statusCode: 409 });

    // Unknown portfolio rejects with 404
    await expect(
      updatePortfolio("00000000-0000-4000-8000-000000000099", { name: "X" }, db),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("updates individual transaction fields (quantity, price, FX rate, commission, notes, portfolio)", async () => {
    const main = await createPortfolio(
      { name: "US Main", type: "holdings", defaultCurrency: "USD" },
      db,
    );
    const alt = await createPortfolio(
      { name: "US Speculative", type: "holdings", defaultCurrency: "USD" },
      db,
    );

    const created = await createTransaction(
      {
        portfolioId: main.id,
        symbol: "MSFT",
        instrumentName: "Microsoft Corporation",
        exchangeCode: "NMS",
        type: "Buy",
        quantity: "2",
        price: "400",
        commission: "1",
        currency: "USD",
        date: "2026-02-01",
        time: "10:00:00",
        offset: "+0800",
        fxRateToSgd: "1.30",
        isManualPrice: true,
        isManualFxRate: true,
        notes: "Initial thesis",
      },
      db,
    );

    await updateTransaction(
      created.id,
      {
        portfolioId: alt.id,
        symbol: "MSFT",
        instrumentName: "Microsoft Corporation",
        exchangeCode: "NMS",
        type: "Buy",
        quantity: "4",
        price: "410",
        commission: "2.50",
        currency: "USD",
        date: "2026-02-02",
        time: "14:30:00",
        offset: "+0800",
        purchaseFxRate: "1.32",
        purchaseFxCurrencies: "USD/SGD",
        fxRateToSgd: "1.32",
        fxSource: "manual",
        isManualPrice: true,
        isManualFxRate: true,
        notes: "Updated thesis & portfolio",
      },
      db,
    );

    const updated = await getEnrichedTransactionById(created.id, db);
    expect(updated).toMatchObject({
      portfolioId: alt.id,
      portfolioName: "US Speculative",
      quantity: "4",
      price: "410",
      commissionRaw: "2.50",
      localDate: "2026-02-02",
      localTime: "14:30:00",
      fxRateToSgd: "1.32",
      // 4 * 410 * 1.32 = 2164.8
      totalCostSgd: "2164.8",
      notes: "Updated thesis & portfolio",
    });

    const summary = await computeLedgerSummaries(undefined, db);
    expect(summary.positions).toHaveLength(1);
    expect(summary.positions[0]?.portfolioId).toBe(alt.id);
    expect(summary.positions[0]?.sharesHeld).toBe("4");
  });

  it("deletes a portfolio, cascades its transactions, and resets defaultPortfolioId to all when needed", async () => {
    const p1 = await createPortfolio(
      { name: "Core US", type: "holdings", defaultCurrency: "USD" },
      db,
    );
    const p2 = await createPortfolio(
      { name: "SG Income", type: "holdings", defaultCurrency: "SGD" },
      db,
    );

    await createTransaction(
      {
        portfolioId: p1.id,
        symbol: "AAPL",
        type: "Buy",
        quantity: "10",
        price: "190",
        date: "2025-01-10",
      },
      db,
    );
    await createTransaction(
      {
        portfolioId: p2.id,
        symbol: "D05.SI",
        type: "Buy",
        quantity: "100",
        price: "40",
        currency: "SGD",
        date: "2025-02-10",
      },
      db,
    );

    const updatedSettings = await updateSettings(
      { defaultPortfolioId: p1.id },
      db,
    );
    expect(updatedSettings.defaultPortfolioId).toBe(p1.id);
    expect(
      resolveDefaultPortfolioId(updatedSettings.defaultPortfolioId, [p1, p2]),
    ).toBe(p1.id);

    await deletePortfolio(p1.id, db);

    const remainingPortfolios = await listPortfolios(db);
    expect(remainingPortfolios.map((p) => p.id)).toEqual([p2.id]);

    const remainingTxs = await listEnrichedTransactions({}, db);
    expect(remainingTxs).toHaveLength(1);
    expect(remainingTxs[0]?.portfolioId).toBe(p2.id);

    const settingsAfterDelete = await getOrCreateSettings(db);
    expect(settingsAfterDelete.defaultPortfolioId).toBe("all");
    expect(
      resolveDefaultPortfolioId(p1.id, remainingPortfolios),
    ).toBe("all");

    await expect(
      deletePortfolio("00000000-0000-4000-8000-000000000099", db),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("directly edits current holdings (shares & avg cost) while preserving closed trades, splits, and realized P&L", async () => {
    const us = await createPortfolio(
      { name: "US Stocks", type: "holdings", defaultCurrency: "USD" },
      db,
    );
    const watchlist = await createPortfolio(
      { name: "Watchlist", type: "watchlist", defaultCurrency: "USD" },
      db,
    );

    // Case 1: Single open Buy lot -> preserves original date and updates shares & avg cost cleanly
    await createTransaction(
      {
        portfolioId: us.id,
        symbol: "AAPL",
        instrumentName: "Apple Inc.",
        type: "Buy",
        quantity: "5",
        price: "180",
        commission: "5",
        currency: "USD",
        date: "2024-03-15",
        fxRateToSgd: "1.34",
      },
      db,
    );

    const adjusted1 = await adjustPortfolioHolding(
      {
        portfolioId: us.id,
        symbol: "AAPL",
        targetShares: "12.5",
        targetAverageCost: "192.40",
      },
      db,
    );
    expect(adjusted1.sharesHeld).toBe("12.5");
    expect(Number(adjusted1.averageCostPerShare)).toBeCloseTo(192.4, 6);
    expect(Number(adjusted1.openCostBasis)).toBeCloseTo(2405, 4);

    const aaplTxs = await listEnrichedTransactions({ portfolioId: us.id }, db);
    expect(aaplTxs).toHaveLength(1);
    expect(aaplTxs[0]?.localDate).toBe("2024-03-15");
    expect(Number(aaplTxs[0]?.fxRateToSgd)).toBeCloseTo(1.34, 4);

    // Case 2: Partial sell + stock split -> preserves exact historical realized P&L
    await createTransaction(
      {
        portfolioId: us.id,
        symbol: "NVDA",
        type: "Buy",
        quantity: "10",
        price: "1000",
        commission: "10", // total $10,010 -> $1,001/pre-split sh -> $100.10/post-split sh
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
    await createTransaction(
      {
        portfolioId: us.id,
        symbol: "NVDA",
        type: "Sell",
        quantity: "40",
        price: "130",
        date: "2024-07-01",
      },
      db,
    );

    // Realized P&L before edit: 40 * 130 - 40 * 100.10 = 5200 - 4004 = 1196
    const beforeNvda = (await computeLedgerSummaries(us.id, db)).positions.find(
      (p) => p.symbol === "NVDA",
    );
    expect(beforeNvda?.sharesHeld).toBe("60");
    expect(Number(beforeNvda?.realizedPnl)).toBeCloseTo(1196, 4);

    // Edit remaining open NVDA holding directly to 75 shares @ $112.50
    const adjustedNvda = await adjustPortfolioHolding(
      {
        portfolioId: us.id,
        symbol: "NVDA",
        targetShares: "75",
        targetAverageCost: "112.50",
      },
      db,
    );
    expect(adjustedNvda.sharesHeld).toBe("75");
    expect(Number(adjustedNvda.averageCostPerShare)).toBeCloseTo(112.5, 6);
    expect(Number(adjustedNvda.openCostBasis)).toBeCloseTo(8437.5, 4);
    expect(Number(adjustedNvda.realizedPnl)).toBeCloseTo(1196, 4);

    // Case 3: Setting targetShares to 0 clears open lots while preserving realized P&L
    const clearedNvda = await adjustPortfolioHolding(
      {
        portfolioId: us.id,
        symbol: "NVDA",
        targetShares: "0",
        targetAverageCost: "0",
      },
      db,
    );
    expect(clearedNvda.sharesHeld).toBe("0");
    expect(clearedNvda.averageCostPerShare).toBeNull();
    expect(Number(clearedNvda.realizedPnl)).toBeCloseTo(1196, 4);

    // Case 4: Validation rejects watchlist and negative values
    await expect(
      adjustPortfolioHolding(
        {
          portfolioId: watchlist.id,
          symbol: "AAPL",
          targetShares: "10",
          targetAverageCost: "150",
        },
        db,
      ),
    ).rejects.toThrow(/watchlist/i);

    await expect(
      adjustPortfolioHolding(
        {
          portfolioId: us.id,
          symbol: "AAPL",
          targetShares: "-5",
          targetAverageCost: "150",
        },
        db,
      ),
    ).rejects.toThrow(/cannot be negative/i);
  });
});

