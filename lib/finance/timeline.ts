/**
 * Pure Historical Portfolio Valuation Timeline & Cash-Flow Reconstructor.
 *
 * Reconstructs daily portfolio market value, open cost basis, external cash
 * flows, cash dividends, and XIRR cash-flow arrays purely from:
 *  - chronological FIFO-ready transactions (with Sell All pre-resolved),
 *  - corporate stock splits,
 *  - daily unadjusted price bars, and
 *  - historical FX rates (`FxRateBook`).
 *
 * Keeping this reconstruction pure and database-free allows exhaustive unit
 * testing and lets the dashboard/benchmarks pages slice timelines cleanly for
 * any portfolio filter (`"all"` or single portfolio) and base currency (`SGD`
 * or `USD`).
 */
import { computeCommissionAmount, parseCommissionInput } from "@/lib/finance/commission";
import { formatInstantInOffset } from "@/lib/finance/date";
import {
  type DecimalValue,
  ONE,
  QUANTITY_EPSILON,
  safeDivide,
  toDecimal,
  toDecimalString,
  toOptionalDecimal,
  ZERO,
} from "@/lib/finance/decimal";
import type { DividendInterpretation, LedgerTransactionInput } from "@/lib/finance/fifo";
import { type FxRateBook, lookupFxRate } from "@/lib/finance/fx";
import type { ExternalCashFlowEvent } from "@/lib/finance/risk-metrics";
import { applySplitToOpenLot, type SplitAction } from "@/lib/finance/splits";
import type { TwrDailyInput } from "@/lib/finance/twr";
import type { XirrCashFlow } from "@/lib/finance/xirr";

export interface TimelineBucketInput {
  portfolioId: string;
  portfolioName: string;
  instrumentId: string;
  symbol: string;
  currency: string;
  manualPrice: string | null;
  isDelisted: boolean;
  /** Transactions for this `(portfolioId, instrumentId)` after Sell All expansion. */
  transactions: readonly LedgerTransactionInput[];
}

export interface TimelinePoint {
  date: string;
  /** End-of-day mark-to-market value across priced open holdings (`baseCurrency`). */
  portfolioValue: string;
  /** FIFO cost basis of remaining open priced holdings (`baseCurrency`). */
  openCostBasis: string;
  /** Net external cash invested up to `date` (`sum(Buys) - sum(Sells)` in `baseCurrency`). */
  netCashInvested: string;
}

export interface PortfolioTimelineResult {
  points: TimelinePoint[];
  twrInputs: TwrDailyInput[];
  xirrCashFlows: XirrCashFlow[];
  externalCashFlows: ExternalCashFlowEvent[];
  excludedUnpricedSymbols: string[];
  firstTransactionDate: string | null;
  lastValuationDate: string | null;
  /** Ending mark-to-market value across priced holdings on `asOfDate`. */
  endingMarketValue: string;
  /** Total cash cost put into buys (across priced holdings). */
  totalDepositsInBase: string;
  /** Total cash proceeds + cash dividends returned (across priced holdings). */
  totalWithdrawalsAndDividendsInBase: string;
}

interface InternalLot {
  remainingShares: DecimalValue;
  initialShares: DecimalValue;
  remainingCostBasis: DecimalValue;
  costPerShare: DecimalValue;
  remainingCostBasisInBase: DecimalValue | null;
}

function nextCalendarDay(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}

/**
 * Generates sorted market weekdays (`Mon–Fri`) in `[startDate .. endDate]`,
 * appending `endDate` if it lands on a weekend (so Saturday/Sunday views
 * always end cleanly on today's date using latest prior closes).
 */
export function buildTradingCalendarDates(
  startDate: string,
  endDate: string,
): string[] {
  if (!startDate || !endDate || startDate > endDate) {
    return [];
  }
  const dates: string[] = [];
  let cursor = startDate;
  let guard = 0;

  while (cursor <= endDate && guard < 10_000) {
    const [y, m, d] = cursor.split("-").map(Number);
    const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (dayOfWeek >= 1 && dayOfWeek <= 5) {
      dates.push(cursor);
    }
    cursor = nextCalendarDay(cursor);
    guard += 1;
  }

  if (dates.length === 0 || dates[dates.length - 1] !== endDate) {
    dates.push(endDate);
  }
  return dates;
}

function sortTxsChronologically(
  transactions: readonly LedgerTransactionInput[],
): LedgerTransactionInput[] {
  return [...transactions].sort((a, b) => {
    const diff = a.executedAt.getTime() - b.executedAt.getTime();
    if (diff !== 0) return diff;
    const rowA = a.sourceRowId ?? Number.MAX_SAFE_INTEGER;
    const rowB = b.sourceRowId ?? Number.MAX_SAFE_INTEGER;
    if (rowA !== rowB) return rowA - rowB;
    return a.id.localeCompare(b.id);
  });
}

function resolveTxCommission(tx: LedgerTransactionInput): {
  value: DecimalValue;
  isPercent: boolean;
} {
  if (tx.commissionValue !== undefined && tx.commissionValue !== null) {
    return {
      value: toDecimal(tx.commissionValue),
      isPercent: Boolean(tx.commissionIsPercent),
    };
  }
  const parsed = parseCommissionInput(tx.commissionRaw);
  return { value: parsed.value, isPercent: parsed.isPercent };
}

/**
 * Resolves a historical native-currency unit price on `targetDate` by scanning
 * sorted bar dates via binary search for the latest bar date `<= targetDate`
 * (allowing up to 15 calendar days lookback for holidays/weekends).
 */
function lookupHistoricalUnitPrice(params: {
  targetDate: string;
  sortedBarDates: readonly string[];
  barsByDate: ReadonlyMap<string, string>;
  livePriceOnAsOfDate: string | null;
  asOfDate: string;
  manualPrice: string | null;
  isDelisted: boolean;
}): DecimalValue | null {
  if (params.isDelisted) {
    return params.manualPrice ? toDecimal(params.manualPrice) : ZERO;
  }
  if (
    params.targetDate === params.asOfDate &&
    params.livePriceOnAsOfDate !== null
  ) {
    return toDecimal(params.livePriceOnAsOfDate);
  }
  if (params.manualPrice !== null && params.sortedBarDates.length === 0) {
    return toDecimal(params.manualPrice);
  }
  if (params.sortedBarDates.length === 0) {
    return null;
  }

  // Binary search for greatest bar date <= targetDate
  let low = 0;
  let high = params.sortedBarDates.length - 1;
  let matchIdx = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (params.sortedBarDates[mid] <= params.targetDate) {
      matchIdx = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (matchIdx < 0) {
    // If the trade happened on the exact holiday/day before first listed bar within 7 days,
    // use the earliest bar within 7 days; otherwise mark unavailable on this earlier day.
    const firstDate = params.sortedBarDates[0];
    const [ty, tm, td] = params.targetDate.split("-").map(Number);
    const [fy, fm, fd] = firstDate.split("-").map(Number);
    const deltaDays =
      (Date.UTC(fy, fm - 1, fd) - Date.UTC(ty, tm - 1, td)) / 86_400_000;
    if (deltaDays >= 0 && deltaDays <= 7) {
      const firstClose = params.barsByDate.get(firstDate);
      return firstClose ? toDecimal(firstClose) : null;
    }
    return null;
  }

  const matchedDate = params.sortedBarDates[matchIdx];
  const rawPrice = params.barsByDate.get(matchedDate);
  return rawPrice ? toDecimal(rawPrice) : null;
}

function resolveFxMultiplier(params: {
  fromCurrency: string;
  toCurrency: string;
  date: string;
  fxBook: FxRateBook;
  fallbackUsdToSgd: DecimalValue | null;
  explicitRate?: string | number | null;
  explicitCurrencies?: string | null;
}): DecimalValue | null {
  const from = params.fromCurrency.toUpperCase();
  const to = params.toCurrency.toUpperCase();
  if (from === to) {
    return ONE;
  }

  const lookup = lookupFxRate({
    fromCurrency: from,
    toCurrency: to,
    date: params.date,
    explicitRate: params.explicitRate,
    explicitCurrencies: params.explicitCurrencies,
    rateBook: params.fxBook,
    maxLookbackDays: 14,
  });

  if (lookup.rate !== null) {
    return lookup.rate;
  }

  if (params.fallbackUsdToSgd && params.fallbackUsdToSgd.gt(ZERO)) {
    if (from === "USD" && to === "SGD") {
      return params.fallbackUsdToSgd;
    }
    if (from === "SGD" && to === "USD") {
      return safeDivide(ONE, params.fallbackUsdToSgd);
    }
  }
  return null;
}

/**
 * Reconstructs daily portfolio valuation, external cash flows, TWR inputs, and
 * XIRR cash-flow arrays across `[earliestTxDate .. asOfDate]`.
 *
 * Formula in words:
 *   For each trading day `t`:
 *     `PortfolioValue(t) = sum_i( sharesHeld_i(t) * barClose_i(t) * fxToBase(currency_i, t) )`
 *     `ExternalFlow(t)   = sum_buys(costInBase) - sum_sells(netProceedsInBase)`
 */
export function reconstructPortfolioTimeline(params: {
  buckets: readonly TimelineBucketInput[];
  splitsByInstrument: ReadonlyMap<string, readonly SplitAction[]>;
  dailyBarsByInstrument: ReadonlyMap<string, ReadonlyMap<string, string>>;
  livePricesByInstrument?: ReadonlyMap<string, string>;
  fxBook: FxRateBook;
  fallbackUsdToSgd?: string | null;
  baseCurrency: "SGD" | "USD";
  dividendMode: DividendInterpretation;
  asOfDate: string;
}): PortfolioTimelineResult {
  const fallbackFxDec = toOptionalDecimal(params.fallbackUsdToSgd);
  const baseCurrency = params.baseCurrency;

  // 1. Identify which instruments have reliable valuation pricing history.
  const excludedUnpricedSet = new Set<string>();
  const sortedBarDatesByInstrument = new Map<string, string[]>();

  for (const bucket of params.buckets) {
    const barsMap = params.dailyBarsByInstrument.get(bucket.instrumentId);
    const barDates = barsMap ? [...barsMap.keys()].sort() : [];
    sortedBarDatesByInstrument.set(bucket.instrumentId, barDates);

    const hasLive = params.livePricesByInstrument?.has(bucket.instrumentId) ?? false;
    const hasHistory =
      barDates.length > 0 ||
      bucket.manualPrice !== null ||
      bucket.isDelisted ||
      hasLive;

    if (!hasHistory) {
      excludedUnpricedSet.add(bucket.symbol);
    }
  }

  const allDatesFromAllTxs = params.buckets.flatMap((b) =>
    b.transactions.map(
      (tx) => formatInstantInOffset(tx.executedAt, tx.originalOffset ?? "+0800").localDate,
    ),
  );
  const overallFirstTxDate = allDatesFromAllTxs.sort()[0] ?? null;

  const pricedBuckets = params.buckets.filter(
    (b) => !excludedUnpricedSet.has(b.symbol) && b.transactions.length > 0,
  );

  const preparedBuckets = pricedBuckets.map((bucket) => {
    const txs = sortTxsChronologically(bucket.transactions).map((tx) => {
      const localDate = formatInstantInOffset(
        tx.executedAt,
        tx.originalOffset ?? "+0800",
      ).localDate;
      return { tx, localDate };
    });

    const splits = [...(params.splitsByInstrument.get(bucket.instrumentId) ?? [])].sort(
      (a, b) => a.exDate.localeCompare(b.exDate),
    );

    return {
      bucket,
      txs,
      splits,
      openLots: [] as InternalLot[],
      txIdx: 0,
      splitIdx: 0,
    };
  });

  const earliestTxDate =
    preparedBuckets
      .flatMap((b) => b.txs.map((t) => t.localDate))
      .sort()[0] ?? null;

  if (earliestTxDate === null || earliestTxDate > params.asOfDate) {
    return {
      points: [],
      twrInputs: [],
      xirrCashFlows: [],
      externalCashFlows: [],
      excludedUnpricedSymbols: [...excludedUnpricedSet].sort(),
      firstTransactionDate: overallFirstTxDate,
      lastValuationDate: null,
      endingMarketValue: "0.00",
      totalDepositsInBase: "0.00",
      totalWithdrawalsAndDividendsInBase: "0.00",
    };
  }

  const tradingDates = buildTradingCalendarDates(earliestTxDate, params.asOfDate);

  const points: TimelinePoint[] = [];
  const twrInputs: TwrDailyInput[] = [];
  const xirrCashFlows: XirrCashFlow[] = [];
  const externalCashFlows: ExternalCashFlowEvent[] = [];

  let cumulativeNetInvested = ZERO;
  let totalDepositsInBase = ZERO;
  let totalWithdrawalsAndDividendsInBase = ZERO;

  for (const date of tradingDates) {
    let dayExternalFlow = ZERO;
    let dayDividendFlow = ZERO;

    // Advance every bucket's FIFO lots + splits through `date`
    for (const state of preparedBuckets) {
      const { bucket, txs, splits } = state;

      while (state.txIdx < txs.length && txs[state.txIdx].localDate <= date) {
        const { tx, localDate } = txs[state.txIdx];
        state.txIdx += 1;

        while (
          state.splitIdx < splits.length &&
          splits[state.splitIdx].exDate <= localDate
        ) {
          for (const lot of state.openLots) {
            if (lot.remainingShares.gt(QUANTITY_EPSILON)) {
              applySplitToOpenLot(lot, splits[state.splitIdx]);
            }
          }
          state.splitIdx += 1;
        }

        const qty = toDecimal(tx.quantity);
        const price = toDecimal(tx.price);
        const { value: commVal, isPercent: commIsPct } = resolveTxCommission(tx);
        const fx =
          resolveFxMultiplier({
            fromCurrency: bucket.currency,
            toCurrency: baseCurrency,
            date: localDate,
            fxBook: params.fxBook,
            fallbackUsdToSgd: fallbackFxDec,
            explicitRate:
              tx.purchaseFxRate !== undefined && tx.purchaseFxRate !== null
                ? String(tx.purchaseFxRate)
                : null,
            explicitCurrencies: tx.purchaseFxCurrencies,
          }) ?? ONE;

        if (tx.type === "Buy") {
          const gross = qty.mul(price);
          const commission = computeCommissionAmount(gross, {
            value: commVal,
            isPercent: commIsPct,
          });
          const totalNative = gross.plus(commission);
          const costBase = totalNative.mul(fx);

          state.openLots.push({
            remainingShares: qty,
            initialShares: qty,
            remainingCostBasis: totalNative,
            costPerShare: safeDivide(totalNative, qty) ?? price,
            remainingCostBasisInBase: costBase,
          });

          if (costBase.gt(ZERO)) {
            dayExternalFlow = dayExternalFlow.plus(costBase);
            cumulativeNetInvested = cumulativeNetInvested.plus(costBase);
            totalDepositsInBase = totalDepositsInBase.plus(costBase);
            xirrCashFlows.push({
              date: localDate,
              amount: costBase.negated().toDecimalPlaces(6),
            });
            externalCashFlows.push({
              date: localDate,
              netFlow: costBase.toDecimalPlaces(6),
            });
          }
        } else if (tx.type === "Sell" || tx.type === "Sell All") {
          let totalOpen = ZERO;
          for (const lot of state.openLots) {
            totalOpen = totalOpen.plus(lot.remainingShares);
          }

          const sharesToSell =
            tx.type === "Sell All"
              ? totalOpen
              : qty.gt(totalOpen)
                ? totalOpen
                : qty;

          if (sharesToSell.gt(QUANTITY_EPSILON)) {
            const grossProceeds = sharesToSell.mul(price);
            const commission = computeCommissionAmount(grossProceeds, {
              value: commVal,
              isPercent: commIsPct,
            });
            const netProceeds = grossProceeds.minus(commission);
            const netProceedsBase = netProceeds.mul(fx);

            // Deplete FIFO lots
            let remainingToSell = sharesToSell;
            for (const lot of state.openLots) {
              if (!remainingToSell.gt(QUANTITY_EPSILON)) break;
              if (!lot.remainingShares.gt(QUANTITY_EPSILON)) continue;

              const matched = remainingToSell.lte(lot.remainingShares)
                ? remainingToSell
                : lot.remainingShares;
              const ratio = matched.div(lot.remainingShares);
              const matchedCost = lot.remainingCostBasis.mul(ratio);
              lot.remainingShares = lot.remainingShares.minus(matched);
              lot.remainingCostBasis = lot.remainingCostBasis.minus(matchedCost);
              if (lot.remainingCostBasisInBase !== null) {
                lot.remainingCostBasisInBase =
                  lot.remainingCostBasisInBase.minus(
                    lot.remainingCostBasisInBase.mul(ratio),
                  );
              }
              remainingToSell = remainingToSell.minus(matched);
            }

            if (netProceedsBase.gt(ZERO)) {
              dayExternalFlow = dayExternalFlow.minus(netProceedsBase);
              cumulativeNetInvested = cumulativeNetInvested.minus(netProceedsBase);
              totalWithdrawalsAndDividendsInBase =
                totalWithdrawalsAndDividendsInBase.plus(netProceedsBase);
              xirrCashFlows.push({
                date: localDate,
                amount: netProceedsBase.toDecimalPlaces(6),
              });
              externalCashFlows.push({
                date: localDate,
                netFlow: netProceedsBase.negated().toDecimalPlaces(6),
              });
            }
          }
        } else if (tx.type === "Dividend") {
          if (params.dividendMode === "cash") {
            const grossDiv = qty;
            const comm = computeCommissionAmount(grossDiv, {
              value: commVal,
              isPercent: commIsPct,
            });
            const netDiv = grossDiv.minus(comm);
            const divBase = netDiv.mul(fx);
            if (divBase.gt(ZERO)) {
              dayDividendFlow = dayDividendFlow.plus(divBase);
              totalWithdrawalsAndDividendsInBase =
                totalWithdrawalsAndDividendsInBase.plus(divBase);
              xirrCashFlows.push({
                date: localDate,
                amount: divBase.toDecimalPlaces(6),
              });
            }
          } else {
            // Reinvested dividend shares add shares without external cash flow
            const gross = qty.mul(price);
            const comm = computeCommissionAmount(gross, {
              value: commVal,
              isPercent: commIsPct,
            });
            const totalNative = gross.plus(comm);
            state.openLots.push({
              remainingShares: qty,
              initialShares: qty,
              remainingCostBasis: totalNative,
              costPerShare: safeDivide(totalNative, qty) ?? price,
              remainingCostBasisInBase: totalNative.mul(fx),
            });
          }
        }
      }

      // Apply any remaining splits up to `date`
      while (state.splitIdx < splits.length && splits[state.splitIdx].exDate <= date) {
        for (const lot of state.openLots) {
          if (lot.remainingShares.gt(QUANTITY_EPSILON)) {
            applySplitToOpenLot(lot, splits[state.splitIdx]);
          }
        }
        state.splitIdx += 1;
      }
    }

    // Value every open lot as of `date`
    let dayMarketValue = ZERO;
    let dayOpenCostBasis = ZERO;

    for (const state of preparedBuckets) {
      let openShares = ZERO;
      let bucketCostBase = ZERO;

      for (const lot of state.openLots) {
        if (lot.remainingShares.gt(QUANTITY_EPSILON)) {
          openShares = openShares.plus(lot.remainingShares);
          if (lot.remainingCostBasisInBase !== null) {
            bucketCostBase = bucketCostBase.plus(lot.remainingCostBasisInBase);
          }
        }
      }

      if (!openShares.gt(QUANTITY_EPSILON)) {
        continue;
      }

      dayOpenCostBasis = dayOpenCostBasis.plus(bucketCostBase);

      const unitPrice = lookupHistoricalUnitPrice({
        targetDate: date,
        sortedBarDates:
          sortedBarDatesByInstrument.get(state.bucket.instrumentId) ?? [],
        barsByDate:
          params.dailyBarsByInstrument.get(state.bucket.instrumentId) ??
          new Map(),
        livePriceOnAsOfDate:
          params.livePricesByInstrument?.get(state.bucket.instrumentId) ?? null,
        asOfDate: params.asOfDate,
        manualPrice: state.bucket.manualPrice,
        isDelisted: state.bucket.isDelisted,
      });

      const fx =
        resolveFxMultiplier({
          fromCurrency: state.bucket.currency,
          toCurrency: baseCurrency,
          date,
          fxBook: params.fxBook,
          fallbackUsdToSgd: fallbackFxDec,
        }) ?? ONE;

      if (unitPrice !== null) {
        dayMarketValue = dayMarketValue.plus(openShares.mul(unitPrice).mul(fx));
      }
    }

    const mvRounded = dayMarketValue.toDecimalPlaces(2);
    const cbRounded = dayOpenCostBasis.toDecimalPlaces(2);
    const netInvestedClamped = cumulativeNetInvested.toDecimalPlaces(2);

    points.push({
      date,
      portfolioValue: toDecimalString(mvRounded, 2),
      openCostBasis: toDecimalString(cbRounded, 2),
      netCashInvested: toDecimalString(netInvestedClamped, 2),
    });

    twrInputs.push({
      date,
      portfolioValue: mvRounded,
      externalCashFlow: dayExternalFlow.toDecimalPlaces(6),
      dividendInflow: dayDividendFlow.toDecimalPlaces(6),
    });
  }

  const lastPoint = points[points.length - 1];
  const endingMarketValue = lastPoint ? toDecimal(lastPoint.portfolioValue) : ZERO;

  if (endingMarketValue.gt(QUANTITY_EPSILON)) {
    xirrCashFlows.push({
      date: params.asOfDate,
      amount: endingMarketValue.toDecimalPlaces(6),
    });
  }

  return {
    points,
    twrInputs,
    xirrCashFlows,
    externalCashFlows,
    excludedUnpricedSymbols: [...excludedUnpricedSet].sort(),
    firstTransactionDate: overallFirstTxDate,
    lastValuationDate: lastPoint?.date ?? null,
    endingMarketValue: toDecimalString(endingMarketValue, 2),
    totalDepositsInBase: toDecimalString(totalDepositsInBase, 2),
    totalWithdrawalsAndDividendsInBase: toDecimalString(
      totalWithdrawalsAndDividendsInBase,
      2,
    ),
  };
}
