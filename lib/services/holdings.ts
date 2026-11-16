/**
 * Server-Side Holdings & Stock Detail Service (`lib/services/holdings.ts`).
 *
 * Evaluates independent per-portfolio FIFO ledgers across all holdings
 * portfolios, resolves initial quotes + sparklines + `USD -> SGD` FX, and
 * prepares structured data for `/holdings` and `/holdings/[symbol]`.
 */
import { asc, desc, eq } from "drizzle-orm";
import { type Database, getDb } from "@/db/client";
import {
  corporateAction,
  fxRate,
  instrument,
  type Instrument,
  type Portfolio,
  portfolio,
  transaction,
  type Transaction,
} from "@/db/schema";
import {
  applySymbolWideSellAll,
  evaluateFifoLedger,
  formatInstantInOffset,
  FxRateBook,
  HUNDRED,
  isMirroredSellAllId,
  resolveSellAllSourceId,
  safeDivide,
  type SplitAction,
  type TimelineBucketInput,
  toDecimal,
  toDecimalString,
  toNullableDecimalString,
} from "@/lib/finance";
import type {
  SerializedClosedLotMatch,
  SerializedFifoBucket,
  SerializedOpenLot,
} from "@/lib/holdings/valuation";
import {
  type CombinedMarketOverview,
  type ExchangeRateSnapshot,
  fetchExchangeRateToSgd,
  fetchInstrumentFundamentals,
  fetchPriceHistoryForRange,
  getCombinedMarketOverview,
  getSingaporeDateString,
  type InstrumentFundamentals,
  type PriceHistoryResult,
  type ResolvedInstrumentQuote,
  resolveQuotesForSymbols,
  resolveStartDateForRange,
} from "@/lib/market-data";
import { backfillMissingTransactionSgdTotals } from "@/lib/services/fx-sgd";
import {
  type EnrichedCorporateAction,
  type EnrichedTransactionRow,
  getOrCreateSettings,
  listCorporateActions,
  listEnrichedTransactions,
  listPortfolios,
  mapDbTransactionToFifoInput,
} from "@/lib/services/ledger";

export interface HoldingsPageSnapshot {
  portfolios: Portfolio[];
  buckets: SerializedFifoBucket[];
  initialQuotes: Record<string, ResolvedInstrumentQuote>;
  initialFxUsdToSgd: ExchangeRateSnapshot | null;
  initialMarket: CombinedMarketOverview;
  baseCurrency: string;
}

export interface StockDetailSnapshot {
  instrument: {
    id: string;
    symbol: string;
    name: string | null;
    exchangeCode: string | null;
    currency: string;
    assetType: string;
    manualPrice: string | null;
    isDelisted: boolean;
    priceNotFound: boolean;
    priceNotFoundReason: string | null;
  };
  portfolios: Portfolio[];
  buckets: SerializedFifoBucket[];
  transactions: EnrichedTransactionRow[];
  corporateActions: EnrichedCorporateAction[];
  initialQuote: ResolvedInstrumentQuote | undefined;
  initialFxUsdToSgd: ExchangeRateSnapshot | null;
  initialMarket: CombinedMarketOverview;
  fundamentals: InstrumentFundamentals;
  initialHistory: PriceHistoryResult;
  baseCurrency: string;
}

export interface PortfolioFifoSnapshot {
  buckets: SerializedFifoBucket[];
  timelineBuckets: TimelineBucketInput[];
  splitsByInstrument: Map<string, SplitAction[]>;
  fxBook: FxRateBook;
  baseCurrency: string;
  latestCachedUsdSgd: string | null;
  appSettings: Awaited<ReturnType<typeof getOrCreateSettings>>;
  nonSgdMissingFxCount: number;
  holdingsTransactionCount: number;
}

/**
 * Evaluates independent FIFO buckets across all holdings portfolios (optionally
 * filtered to a single `instrumentId`), and exposes expanded timeline inputs,
 * FX book, and corporate splits for analytics without duplicate queries.
 */
export async function loadPortfolioFifoSnapshot(options: {
  instrumentId?: string;
  baseCurrencyOverride?: string;
  db?: Database;
} = {}): Promise<PortfolioFifoSnapshot> {
  const database = options.db ?? (await getDb());
  // These four reads are independent, so run them concurrently: with a remote
  // database each sequential query costs a full network round trip.
  const [appSettings, txRows, splitRows, fxRows] = await Promise.all([
    getOrCreateSettings(database),
    database
      .select({
        tx: transaction,
        portfolioName: portfolio.name,
        portfolioType: portfolio.type,
        instr: instrument,
      })
      .from(transaction)
      .innerJoin(portfolio, eq(transaction.portfolioId, portfolio.id))
      .innerJoin(instrument, eq(transaction.instrumentId, instrument.id))
      .where(
        options.instrumentId
          ? eq(transaction.instrumentId, options.instrumentId)
          : undefined,
      )
      .orderBy(asc(portfolio.sortOrder), asc(instrument.symbol)),
    options.instrumentId
      ? database
          .select()
          .from(corporateAction)
          .where(eq(corporateAction.instrumentId, options.instrumentId))
      : database.select().from(corporateAction),
    database.select().from(fxRate).orderBy(desc(fxRate.date)),
  ]);
  const baseCurrency = (
    options.baseCurrencyOverride ?? appSettings.baseCurrency
  ).toUpperCase();

  const splitsByInstrument = new Map<string, SplitAction[]>();
  for (const s of splitRows) {
    const list = splitsByInstrument.get(s.instrumentId) ?? [];
    list.push({
      id: s.id,
      exDate: s.exDate,
      ratioNumerator: s.ratioNumerator,
      ratioDenominator: s.ratioDenominator,
    });
    splitsByInstrument.set(s.instrumentId, list);
  }

  const fxBook = new FxRateBook(fxRows);
  const latestCachedUsdSgdRow = fxRows.find(
    (r) => r.fromCurrency === "USD" && r.toCurrency === "SGD",
  );

  // Group strictly by (portfolioId, instrumentId) — portfolios stay independent
  const grouped = new Map<
    string,
    {
      portfolioId: string;
      portfolioName: string;
      instr: Instrument;
      txs: Transaction[];
    }
  >();

  for (const row of txRows) {
    if (row.portfolioType !== "holdings") {
      continue;
    }
    const key = `${row.tx.portfolioId}::${row.instr.id}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.txs.push(row.tx);
    } else {
      grouped.set(key, {
        portfolioId: row.tx.portfolioId,
        portfolioName: row.portfolioName,
        instr: row.instr,
        txs: [row.tx],
      });
    }
  }

  const buckets: SerializedFifoBucket[] = [];

  // Every transaction (all holdings portfolios) by id, so a closed trade
  // produced by a mirrored Sell All can show the real sell date and portfolio.
  const allTxById = new Map<string, { tx: Transaction; portfolioName: string }>();
  for (const group of grouped.values()) {
    for (const tx of group.txs) {
      allTxById.set(tx.id, { tx, portfolioName: group.portfolioName });
    }
  }

  // A `Sell All` closes the symbol in EVERY portfolio, so ledgers are evaluated
  // per instrument across portfolios (never one portfolio in isolation).
  const groupsByInstrument = new Map<
    string,
    NonNullable<ReturnType<typeof grouped.get>>[]
  >();
  for (const group of grouped.values()) {
    const list = groupsByInstrument.get(group.instr.id) ?? [];
    list.push(group);
    groupsByInstrument.set(group.instr.id, list);
  }

  const fifoByGroupKey = new Map<string, ReturnType<typeof evaluateFifoLedger>>();
  const timelineBuckets: TimelineBucketInput[] = [];
  let nonSgdMissingFxCount = 0;
  let holdingsTransactionCount = 0;

  for (const instrumentGroups of groupsByInstrument.values()) {
    const instr = instrumentGroups[0].instr;
    const splits = splitsByInstrument.get(instr.id) ?? [];

    for (const group of instrumentGroups) {
      holdingsTransactionCount += group.txs.length;
      if (instr.currency.toUpperCase() !== "SGD") {
        for (const tx of group.txs) {
          if (tx.totalCostSgd === null && tx.purchaseFxRate === null) {
            nonSgdMissingFxCount += 1;
          }
        }
      }
    }

    const expanded = applySymbolWideSellAll(
      instrumentGroups.map((group) => ({
        portfolioId: group.portfolioId,
        transactions: group.txs.map(mapDbTransactionToFifoInput),
      })),
      { symbol: instr.symbol, dividendMode: appSettings.dividendMode, splits },
    );

    for (const group of instrumentGroups) {
      const ledger = expanded.find((l) => l.portfolioId === group.portfolioId);
      const txsForBucket = ledger?.transactions ?? [];
      timelineBuckets.push({
        portfolioId: group.portfolioId,
        portfolioName: group.portfolioName,
        instrumentId: instr.id,
        symbol: instr.symbol,
        currency: instr.currency,
        manualPrice: instr.manualPrice
          ? toDecimalString(toDecimal(instr.manualPrice), 10)
          : null,
        isDelisted: instr.isDelisted,
        transactions: txsForBucket,
      });

      fifoByGroupKey.set(
        `${group.portfolioId}::${instr.id}`,
        evaluateFifoLedger(txsForBucket, {
          symbol: instr.symbol,
          dividendMode: appSettings.dividendMode,
          splits,
          baseCurrency,
          fxRateBook: fxBook,
          onValidationError: "clamp-and-flag",
        }),
      );
    }
  }

  for (const group of grouped.values()) {
    const fifo = fifoByGroupKey.get(`${group.portfolioId}::${group.instr.id}`);
    if (!fifo) {
      continue;
    }

    const openLots: SerializedOpenLot[] = fifo.openLots.map((lot) => ({
      buyTransactionId: lot.buyTransactionId,
      portfolioId: group.portfolioId,
      portfolioName: group.portfolioName,
      localDate: lot.localDate,
      initialShares: toDecimalString(lot.initialShares, 8),
      remainingShares: toDecimalString(lot.remainingShares, 8),
      costPerShare: toDecimalString(lot.costPerShare, 6),
      remainingCostBasis: toDecimalString(lot.remainingCostBasis, 6),
      fxRateToBase: toNullableDecimalString(lot.fxRateToBase, 6),
      remainingCostBasisInBase: toNullableDecimalString(
        lot.remainingCostBasisInBase,
        6,
      ),
      isZeroCostBuy: lot.isZeroCostBuy,
    }));

    const closedLotMatches: SerializedClosedLotMatch[] =
      fifo.closedLotMatches.map((match) => {
        const buyEntry = allTxById.get(match.buyTransactionId);
        const buyDate = buyEntry
          ? formatInstantInOffset(
              new Date(buyEntry.tx.executedAt),
              buyEntry.tx.originalOffset,
            ).localDate
          : formatInstantInOffset(match.openedAt, "+0800").localDate;

        // Mirrored Sell All ids resolve back to the real stored transaction.
        const sellEntry = allTxById.get(
          resolveSellAllSourceId(match.sellTransactionId),
        );
        const sellDate = sellEntry
          ? formatInstantInOffset(
              new Date(sellEntry.tx.executedAt),
              sellEntry.tx.originalOffset,
            ).localDate
          : formatInstantInOffset(match.closedAt, "+0800").localDate;
        const closedViaPortfolioName =
          isMirroredSellAllId(match.sellTransactionId) && sellEntry
            ? sellEntry.portfolioName
            : null;

        const pct = safeDivide(
          match.realizedPnl.mul(HUNDRED),
          match.costBasis,
        );

        return {
          sellTransactionId: match.sellTransactionId,
          buyTransactionId: match.buyTransactionId,
          portfolioId: group.portfolioId,
          portfolioName: group.portfolioName,
          buyDate,
          sellDate,
          closedViaPortfolioName,
          sharesMatched: toDecimalString(match.sharesMatched, 8),
          allocatedCostBasis: toDecimalString(match.costBasis, 6),
          netSaleProceeds: toDecimalString(match.netProceeds, 6),
          realizedPnl: toDecimalString(match.realizedPnl, 6),
          realizedPnlPercent: toNullableDecimalString(pct, 2),
          realizedPnlInBase: toNullableDecimalString(
            match.realizedPnlInBase,
            6,
          ),
        };
      });

    buckets.push({
      portfolioId: group.portfolioId,
      portfolioName: group.portfolioName,
      instrumentId: group.instr.id,
      symbol: group.instr.symbol,
      name: group.instr.name,
      exchangeCode: group.instr.exchangeCode,
      currency: group.instr.currency,
      assetType: group.instr.assetType,
      manualPrice: group.instr.manualPrice
        ? toDecimalString(toDecimal(group.instr.manualPrice), 10)
        : null,
      isDelisted: group.instr.isDelisted,
      priceNotFound: Boolean(group.instr.priceNotFoundAt),
      priceNotFoundReason: group.instr.priceNotFoundReason ?? null,
      sharesHeld: toDecimalString(fifo.sharesHeld, 12),
      openCostBasis: toDecimalString(fifo.openCostBasis, 12),
      openCostBasisInBase: toNullableDecimalString(
        fifo.openCostBasisInBase,
        12,
      ),
      totalCapitalInvested: toDecimalString(fifo.totalCapitalInvested, 12),
      realizedPnl: toDecimalString(fifo.realizedPnl, 12),
      realizedPnlInBase: toNullableDecimalString(fifo.realizedPnlInBase, 12),
      dividendsReceived: toDecimalString(fifo.dividendsReceived, 12),
      dividendsReceivedInBase: toNullableDecimalString(
        fifo.dividendsReceivedInBase,
        12,
      ),
      closedTradeCount: fifo.closedTradeCount,
      winningTradeCount: fifo.winningTradeCount,
      zeroCostBuyCount: fifo.zeroCostBuys.length,
      openLots,
      closedLotMatches,
    });
  }

  return {
    buckets,
    timelineBuckets,
    splitsByInstrument,
    fxBook,
    baseCurrency,
    latestCachedUsdSgd: latestCachedUsdSgdRow?.rate ?? null,
    appSettings,
    nonSgdMissingFxCount,
    holdingsTransactionCount,
  };
}

/**
 * Evaluates independent FIFO buckets across all holdings portfolios (optionally
 * filtered to a single `instrumentId`).
 */
export async function loadSerializedFifoBuckets(options: {
  instrumentId?: string;
  baseCurrencyOverride?: string;
  db?: Database;
} = {}): Promise<{
  buckets: SerializedFifoBucket[];
  baseCurrency: string;
  latestCachedUsdSgd: string | null;
}> {
  const snapshot = await loadPortfolioFifoSnapshot(options);
  return {
    buckets: snapshot.buckets,
    baseCurrency: snapshot.baseCurrency,
    latestCachedUsdSgd: snapshot.latestCachedUsdSgd,
  };
}

/** Server loader for `/holdings`. */
export async function getHoldingsPageSnapshot(
  dbOrOptions?: Database | { db?: Database; cacheOnly?: boolean },
): Promise<HoldingsPageSnapshot> {
  const resolvedOpts =
    dbOrOptions && "select" in dbOrOptions
      ? { db: dbOrOptions, cacheOnly: false }
      : (dbOrOptions ?? {});
  const database = resolvedOpts.db ?? (await getDb());
  const cacheOnly = resolvedOpts.cacheOnly ?? false;

  if (!cacheOnly) {
    // Ensure all historical purchase FX snapshots are populated
    await backfillMissingTransactionSgdTotals({ db: database });
  }

  const [portfolios, { buckets, baseCurrency, latestCachedUsdSgd }] =
    await Promise.all([
      listPortfolios(database),
      loadSerializedFifoBuckets({ db: database }),
    ]);

  const uniqueSymbols = [...new Set(buckets.map((b) => b.symbol))];
  const now = new Date();
  const initialMarket = getCombinedMarketOverview(now);

  const cachedFxSnapshot: ExchangeRateSnapshot | null = latestCachedUsdSgd
    ? {
        from: "USD",
        to: "SGD",
        rate: toDecimalString(toDecimal(latestCachedUsdSgd), 6),
        effectiveDate: initialMarket.sgtDate,
        asOf: now.toISOString(),
        source: "frankfurter",
        label: "Cached FX rate",
        isHistorical: false,
      }
    : null;

  const [initialQuotes, liveFx] = await Promise.all([
    resolveQuotesForSymbols({
      symbols: uniqueSymbols,
      db: database,
      now,
      includeSparklines: true,
      cacheOnly,
    }),
    cacheOnly && cachedFxSnapshot
      ? Promise.resolve(cachedFxSnapshot)
      : fetchExchangeRateToSgd({ from: "USD", now }).catch(
          (): ExchangeRateSnapshot | null => cachedFxSnapshot,
        ),
  ]);

  return {
    portfolios,
    buckets,
    initialQuotes,
    initialFxUsdToSgd: liveFx,
    initialMarket,
    baseCurrency,
  };
}

/** Server loader for `/holdings/[symbol]`. Returns `null` if symbol not found. */
export async function getStockDetailSnapshot(
  rawSymbol: string,
  db?: Database,
): Promise<StockDetailSnapshot | null> {
  const database = db ?? (await getDb());
  const trimmed = rawSymbol.trim();
  if (!trimmed) {
    return null;
  }

  // Match exact symbol first, falling back to case-insensitive match
  const allInstruments = await database.select().from(instrument);
  const targetInstr =
    allInstruments.find((item) => item.symbol === trimmed) ??
    allInstruments.find(
      (item) => item.symbol.toUpperCase() === trimmed.toUpperCase(),
    );

  if (!targetInstr) {
    return null;
  }

  await backfillMissingTransactionSgdTotals({ db: database });
  const now = new Date();
  const initialMarket = getCombinedMarketOverview(now);

  const [
    historyFiveYear,
    portfolios,
    { buckets, baseCurrency, latestCachedUsdSgd },
    transactions,
    allActions,
    quotesMap,
    fundamentals,
    fetchedLiveFx,
  ] = await Promise.all([
    fetchPriceHistoryForRange({
      symbol: targetInstr.symbol,
      range: "5Y",
      db: database,
      now,
    }),
    listPortfolios(database),
    loadSerializedFifoBuckets({
      instrumentId: targetInstr.id,
      db: database,
    }),
    listEnrichedTransactions({ instrumentId: targetInstr.id }, database),
    listCorporateActions(database),
    resolveQuotesForSymbols({
      symbols: [targetInstr.symbol],
      db: database,
      now,
      includeSparklines: true,
    }),
    targetInstr.assetType === "crypto" ||
    targetInstr.isDelisted ||
    Boolean(targetInstr.priceNotFoundAt)
      ? Promise.resolve({
          symbol: targetInstr.symbol,
          name: targetInstr.name,
          currency: targetInstr.currency,
          exchangeName: targetInstr.exchangeCode,
          marketCap: null,
          peTrailing: null,
          dividendYieldPercent: null,
          fiftyTwoWeekHigh: null,
          fiftyTwoWeekLow: null,
          beta: null,
          averageVolume: null,
          sector: null,
          industry: null,
          status: "unavailable" as const,
          asOf: now.toISOString(),
          source: null,
        })
      : fetchInstrumentFundamentals(targetInstr.symbol, { now }),
    fetchExchangeRateToSgd({ from: "USD", now }).catch(() => null),
  ]);

  const liveFx: ExchangeRateSnapshot | null =
    fetchedLiveFx ??
    (latestCachedUsdSgd
      ? {
          from: "USD",
          to: "SGD",
          rate: toDecimalString(toDecimal(latestCachedUsdSgd), 6),
          effectiveDate: initialMarket.sgtDate,
          asOf: now.toISOString(),
          source: "frankfurter",
          label: "Cached FX rate",
          isHistorical: false,
        }
      : null);

  const corporateActions = allActions.filter(
    (action) => action.instrumentId === targetInstr.id,
  );

  const oneYearStart = resolveStartDateForRange("1Y", getSingaporeDateString(now));
  const slicedOneYearBars = historyFiveYear.bars.filter(
    (bar) => bar.date >= oneYearStart,
  );
  const initialHistory: PriceHistoryResult = {
    ...historyFiveYear,
    range: "1Y",
    bars:
      slicedOneYearBars.length > 0 ? slicedOneYearBars : historyFiveYear.bars,
  };

  return {
    instrument: {
      id: targetInstr.id,
      symbol: targetInstr.symbol,
      name: targetInstr.name ?? fundamentals.name ?? null,
      exchangeCode: targetInstr.exchangeCode ?? fundamentals.exchangeName,
      currency: targetInstr.currency,
      assetType: targetInstr.assetType,
      manualPrice: targetInstr.manualPrice
        ? toDecimalString(toDecimal(targetInstr.manualPrice), 10)
        : null,
      isDelisted: targetInstr.isDelisted,
      priceNotFound: Boolean(targetInstr.priceNotFoundAt),
      priceNotFoundReason: targetInstr.priceNotFoundReason ?? null,
    },
    portfolios,
    buckets,
    transactions,
    corporateActions,
    initialQuote: quotesMap[targetInstr.symbol],
    initialFxUsdToSgd: liveFx,
    initialMarket,
    fundamentals,
    initialHistory,
    baseCurrency,
  };
}
