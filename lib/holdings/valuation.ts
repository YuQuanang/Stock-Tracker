/**
 * Client- & Server-Safe Holdings Valuation Mapper (`lib/holdings/valuation.ts`).
 *
 * Combines pre-computed chronological FIFO ledger outputs with live/cached
 * `ResolvedInstrumentQuote` snapshots and the current `USD -> SGD` exchange
 * rate using `Decimal.js` (`computePositionValuation` & `computePortfolioWeights`)
 * so client components can recompute exact P&L on short-poll updates without
 * duplicating financial formulas or touching floating-point math.
 */
import {
  computePortfolioWeights,
  computePositionValuation,
  type DecimalValue,
  HUNDRED,
  QUANTITY_EPSILON,
  type QuoteSnapshot,
  safeDivide,
  toDecimal,
  toDecimalString,
  toNullableDecimalString,
  toOptionalDecimal,
  ZERO,
} from "@/lib/finance";
import type { ResolvedInstrumentQuote } from "@/lib/market-data/batch-quotes";

export interface SerializedOpenLot {
  buyTransactionId: string;
  portfolioId: string;
  portfolioName: string;
  localDate: string;
  initialShares: string;
  remainingShares: string;
  costPerShare: string;
  remainingCostBasis: string;
  fxRateToBase: string | null;
  remainingCostBasisInBase: string | null;
  isZeroCostBuy: boolean;
}

export interface SerializedClosedLotMatch {
  sellTransactionId: string;
  buyTransactionId: string;
  portfolioId: string;
  portfolioName: string;
  buyDate: string;
  sellDate: string;
  /**
   * Name of the portfolio where the real `Sell All` was recorded when this
   * lot was closed by a Sell All from ANOTHER portfolio, otherwise `null`.
   */
  closedViaPortfolioName: string | null;
  sharesMatched: string;
  allocatedCostBasis: string;
  netSaleProceeds: string;
  realizedPnl: string;
  realizedPnlPercent: string | null;
  realizedPnlInBase: string | null;
}

export interface SerializedFifoBucket {
  portfolioId: string;
  portfolioName: string;
  instrumentId: string;
  symbol: string;
  name: string | null;
  exchangeCode: string | null;
  currency: string;
  assetType: string;
  manualPrice: string | null;
  isDelisted: boolean;
  sharesHeld: string;
  openCostBasis: string;
  openCostBasisInBase: string | null;
  totalCapitalInvested: string;
  realizedPnl: string;
  realizedPnlInBase: string | null;
  dividendsReceived: string;
  dividendsReceivedInBase: string | null;
  closedTradeCount: number;
  winningTradeCount: number;
  zeroCostBuyCount: number;
  openLots: SerializedOpenLot[];
  closedLotMatches: SerializedClosedLotMatch[];
}

export interface ValuedHoldingRow {
  key: string;
  instrumentId: string;
  symbol: string;
  name: string | null;
  exchangeCode: string | null;
  currency: string;
  assetType: string;
  manualPrice: string | null;
  isDelisted: boolean;
  portfolioIds: string[];
  portfolioNames: string[];

  isOpenPosition: boolean;
  isClosedPosition: boolean;
  sharesHeld: string;
  averageCostPerShare: string | null;
  costBasis: string;
  costBasisInBase: string | null;
  totalCapitalInvested: string;

  unitPrice: string | null;
  priceSource: string;
  freshnessLabel: string;
  unavailableReason: string | null;
  sparklineCloses: string[];

  marketValue: string | null;
  marketValueInBase: string | null;
  dayChangePerShare: string | null;
  dayChangeAmount: string | null;
  dayChangeInBase: string | null;
  dayChangePercent: string | null;

  unrealizedPnl: string | null;
  unrealizedPnlPercent: string | null;
  unrealizedPnlInBase: string | null;

  realizedPnl: string;
  realizedPnlInBase: string | null;
  dividendsReceived: string;
  dividendsReceivedInBase: string | null;

  totalReturn: string | null;
  totalReturnPercent: string | null;
  totalReturnInBase: string | null;

  weightPercent: string | null;
  closedTradeCount: number;
  winningTradeCount: number;
  zeroCostBuyCount: number;
}

export interface HoldingsOverviewSummary {
  baseCurrency: string;
  totalMarketValueInBase: string;
  totalCostBasisInBase: string;
  totalDayChangeInBase: string;
  totalDayChangePercent: string | null;
  totalUnrealizedPnlInBase: string;
  totalUnrealizedPnlPercent: string | null;
  totalRealizedPnlInBase: string;
  totalDividendsInBase: string;
  totalLifetimeReturnInBase: string;
  openCount: number;
  closedCount: number;
  unpricedOpenSymbols: string[];
}

function mapQuoteStatusToFreshness(
  quote: ResolvedInstrumentQuote | undefined,
): QuoteSnapshot["freshness"] {
  if (!quote || quote.price === null) {
    return "unavailable";
  }
  switch (quote.status) {
    case "live":
      return "live";
    case "delayed":
      return "delayed";
    case "stale_cache":
      return "stale";
    case "last_close":
    case "historical":
    default:
      return "closed";
  }
}

function sumNullableDecimals(
  left: DecimalValue | null,
  right: DecimalValue | null,
): DecimalValue | null {
  if (left === null || right === null) {
    return null;
  }
  return left.plus(right);
}

/**
 * Aggregates FIFO buckets (either filtered to a single portfolio or combined by
 * `symbol` across all portfolios) and values every holding with exact Decimal math.
 */
export function buildValuedHoldings(params: {
  buckets: readonly SerializedFifoBucket[];
  portfolioFilterId: string; // `"all"` or a specific `portfolioId`
  quotes: Readonly<Record<string, ResolvedInstrumentQuote>>;
  usdToSgdRate: string | null;
  baseCurrency?: string;
}): {
  rows: ValuedHoldingRow[];
  summary: HoldingsOverviewSummary;
} {
  const baseCurrency = (params.baseCurrency ?? "SGD").toUpperCase();
  const usdToSgdDec = toOptionalDecimal(params.usdToSgdRate);

  const filteredBuckets =
    params.portfolioFilterId === "all"
      ? params.buckets
      : params.buckets.filter((b) => b.portfolioId === params.portfolioFilterId);

  // Group by `instrumentId` when viewing `"all"`, or `(portfolioId, instrumentId)` otherwise.
  const grouped = new Map<
    string,
    {
      key: string;
      instrumentId: string;
      symbol: string;
      name: string | null;
      exchangeCode: string | null;
      currency: string;
      assetType: string;
      manualPrice: string | null;
      isDelisted: boolean;
      portfolioIds: string[];
      portfolioNames: string[];
      sharesHeld: DecimalValue;
      openCostBasis: DecimalValue;
      openCostBasisInBase: DecimalValue | null;
      totalCapitalInvested: DecimalValue;
      realizedPnl: DecimalValue;
      realizedPnlInBase: DecimalValue | null;
      dividendsReceived: DecimalValue;
      dividendsReceivedInBase: DecimalValue | null;
      closedTradeCount: number;
      winningTradeCount: number;
      zeroCostBuyCount: number;
    }
  >();

  for (const b of filteredBuckets) {
    const groupKey =
      params.portfolioFilterId === "all"
        ? b.instrumentId
        : `${b.portfolioId}::${b.instrumentId}`;

    const shares = toDecimal(b.sharesHeld);
    const openCost = toDecimal(b.openCostBasis);
    const openCostBase = toOptionalDecimal(b.openCostBasisInBase);
    const capInvested = toDecimal(b.totalCapitalInvested);
    const realized = toDecimal(b.realizedPnl);
    const realizedBase = toOptionalDecimal(b.realizedPnlInBase);
    const divs = toDecimal(b.dividendsReceived);
    const divsBase = toOptionalDecimal(b.dividendsReceivedInBase);

    const existing = grouped.get(groupKey);
    if (!existing) {
      grouped.set(groupKey, {
        key: groupKey,
        instrumentId: b.instrumentId,
        symbol: b.symbol,
        name: b.name,
        exchangeCode: b.exchangeCode,
        currency: b.currency,
        assetType: b.assetType,
        manualPrice: b.manualPrice,
        isDelisted: b.isDelisted,
        portfolioIds: [b.portfolioId],
        portfolioNames: [b.portfolioName],
        sharesHeld: shares,
        openCostBasis: openCost,
        openCostBasisInBase: shares.gt(QUANTITY_EPSILON) ? openCostBase : ZERO,
        totalCapitalInvested: capInvested,
        realizedPnl: realized,
        realizedPnlInBase: realizedBase,
        dividendsReceived: divs,
        dividendsReceivedInBase: divsBase,
        closedTradeCount: b.closedTradeCount,
        winningTradeCount: b.winningTradeCount,
        zeroCostBuyCount: b.zeroCostBuyCount,
      });
    } else {
      if (!existing.portfolioIds.includes(b.portfolioId)) {
        existing.portfolioIds.push(b.portfolioId);
        existing.portfolioNames.push(b.portfolioName);
      }
      existing.sharesHeld = existing.sharesHeld.plus(shares);
      existing.openCostBasis = existing.openCostBasis.plus(openCost);
      existing.openCostBasisInBase = sumNullableDecimals(
        existing.openCostBasisInBase,
        shares.gt(QUANTITY_EPSILON) ? openCostBase : ZERO,
      );
      existing.totalCapitalInvested =
        existing.totalCapitalInvested.plus(capInvested);
      existing.realizedPnl = existing.realizedPnl.plus(realized);
      existing.realizedPnlInBase = sumNullableDecimals(
        existing.realizedPnlInBase,
        realizedBase,
      );
      existing.dividendsReceived = existing.dividendsReceived.plus(divs);
      existing.dividendsReceivedInBase = sumNullableDecimals(
        existing.dividendsReceivedInBase,
        divsBase,
      );
      existing.closedTradeCount += b.closedTradeCount;
      existing.winningTradeCount += b.winningTradeCount;
      existing.zeroCostBuyCount += b.zeroCostBuyCount;
    }
  }

  const intermediate: {
    group: NonNullable<ReturnType<typeof grouped.get>>;
    valuation: ReturnType<typeof computePositionValuation>;
    quote: ResolvedInstrumentQuote | undefined;
  }[] = [];

  for (const group of grouped.values()) {
    const quote = params.quotes[group.symbol];
    const upperCurrency = group.currency.toUpperCase();

    let fxToBase: DecimalValue | null = null;
    if (upperCurrency === baseCurrency) {
      fxToBase = toDecimal(1);
    } else if (upperCurrency === "USD" && baseCurrency === "SGD") {
      fxToBase = usdToSgdDec;
    } else if (
      upperCurrency === "SGD" &&
      baseCurrency === "USD" &&
      usdToSgdDec !== null &&
      usdToSgdDec.gt(ZERO)
    ) {
      fxToBase = toDecimal(1).div(usdToSgdDec);
    }

    const syntheticFifo = {
      openLots: [],
      closedLotMatches:
        group.closedTradeCount > 0 ? ([{}] as never[]) : ([] as never[]),
      dividends: group.dividendsReceived.gt(ZERO)
        ? ([{}] as never[])
        : ([] as never[]),
      sharesHeld: group.sharesHeld,
      openCostBasis: group.openCostBasis,
      openCostBasisInBase: group.openCostBasisInBase,
      totalCapitalInvested: group.totalCapitalInvested,
      realizedPnl: group.realizedPnl,
      realizedPnlInBase: group.realizedPnlInBase,
      dividendsReceived: group.dividendsReceived,
      dividendsReceivedInBase: group.dividendsReceivedInBase,
      closedTradeCount: group.closedTradeCount,
      winningTradeCount: group.winningTradeCount,
      zeroCostBuys: [],
      missingFxFlags: [],
      validationIssues: [],
    };

    const valuation = computePositionValuation(syntheticFifo, {
      currency: group.currency,
      manualPrice: group.manualPrice,
      isDelisted: group.isDelisted,
      quote: quote
        ? {
            price: quote.price,
            previousClose: quote.previousClose,
            freshness: mapQuoteStatusToFreshness(quote),
          }
        : null,
      currentFxRateToBase: fxToBase,
    });

    // Only include symbols with open shares or historical realized/dividend activity
    if (valuation.isOpenPosition || valuation.isClosedPosition) {
      intermediate.push({ group, valuation, quote });
    }
  }

  // Portfolio weights are computed in base currency across priced open positions
  const openBaseValues = intermediate.map((item) =>
    item.valuation.isOpenPosition ? item.valuation.marketValueInBase : null,
  );
  const weights = computePortfolioWeights(openBaseValues);

  let totalMarketValueInBase = ZERO;
  let totalCostBasisOfPricedOpenInBase = ZERO;
  let totalCostBasisAllOpenInBase = ZERO;
  let totalDayChangeInBase = ZERO;
  let totalPrevDayMarketValueInBase = ZERO;
  let totalRealizedPnlInBase = ZERO;
  let totalDividendsInBase = ZERO;
  let openCount = 0;
  let closedCount = 0;
  const unpricedOpenSymbols: string[] = [];

  const rows: ValuedHoldingRow[] = intermediate.map((item, idx) => {
    const { group, valuation, quote } = item;
    const weight = weights[idx];

    if (valuation.isOpenPosition) {
      openCount += 1;
      if (valuation.costBasisInBase !== null) {
        totalCostBasisAllOpenInBase = totalCostBasisAllOpenInBase.plus(
          valuation.costBasisInBase,
        );
      }
      if (valuation.marketValueInBase !== null) {
        totalMarketValueInBase = totalMarketValueInBase.plus(
          valuation.marketValueInBase,
        );
        if (valuation.costBasisInBase !== null) {
          totalCostBasisOfPricedOpenInBase =
            totalCostBasisOfPricedOpenInBase.plus(valuation.costBasisInBase);
        }
        if (valuation.dayChangeInBase !== null) {
          totalDayChangeInBase = totalDayChangeInBase.plus(
            valuation.dayChangeInBase,
          );
          totalPrevDayMarketValueInBase = totalPrevDayMarketValueInBase.plus(
            valuation.marketValueInBase.minus(valuation.dayChangeInBase),
          );
        }
      } else {
        unpricedOpenSymbols.push(group.symbol);
      }
    } else if (valuation.isClosedPosition) {
      closedCount += 1;
    }

    if (valuation.realizedPnlInBase !== null) {
      totalRealizedPnlInBase = totalRealizedPnlInBase.plus(
        valuation.realizedPnlInBase,
      );
    }
    if (valuation.dividendsReceivedInBase !== null) {
      totalDividendsInBase = totalDividendsInBase.plus(
        valuation.dividendsReceivedInBase,
      );
    }

    const freshnessLabel = group.isDelisted
      ? group.manualPrice
        ? "Marked delisted (manual)"
        : "Marked worthless ($0)"
      : group.manualPrice !== null
        ? "Manual price"
        : (quote?.freshnessLabel ?? "Price unavailable");

    return {
      key: group.key,
      instrumentId: group.instrumentId,
      symbol: group.symbol,
      name: group.name ?? quote?.name ?? null,
      exchangeCode: group.exchangeCode ?? quote?.exchangeCode ?? null,
      currency: group.currency,
      assetType: group.assetType,
      manualPrice: group.manualPrice,
      isDelisted: group.isDelisted,
      portfolioIds: group.portfolioIds,
      portfolioNames: group.portfolioNames,

      isOpenPosition: valuation.isOpenPosition,
      isClosedPosition: valuation.isClosedPosition,
      sharesHeld: toDecimalString(valuation.sharesHeld, 8),
      averageCostPerShare: toNullableDecimalString(
        valuation.averageCostPerShare,
        6,
      ),
      costBasis: toDecimalString(valuation.costBasis, 6),
      costBasisInBase: toNullableDecimalString(valuation.costBasisInBase, 6),
      totalCapitalInvested: toDecimalString(group.totalCapitalInvested, 6),

      unitPrice: toNullableDecimalString(valuation.unitPrice, 6),
      priceSource: valuation.priceSource,
      freshnessLabel,
      unavailableReason: quote?.unavailableReason ?? null,
      sparklineCloses: quote?.sparklineCloses ?? [],

      marketValue: toNullableDecimalString(valuation.marketValue, 6),
      marketValueInBase: toNullableDecimalString(
        valuation.marketValueInBase,
        6,
      ),
      dayChangePerShare: quote?.dayChange ?? null,
      dayChangeAmount: toNullableDecimalString(valuation.dayChangeAmount, 6),
      dayChangeInBase: toNullableDecimalString(valuation.dayChangeInBase, 6),
      dayChangePercent: toNullableDecimalString(valuation.dayChangePercent, 2),

      unrealizedPnl: toNullableDecimalString(valuation.unrealizedPnl, 6),
      unrealizedPnlPercent: toNullableDecimalString(
        valuation.unrealizedPnlPercent,
        2,
      ),
      unrealizedPnlInBase: toNullableDecimalString(
        valuation.unrealizedPnlInBase,
        6,
      ),

      realizedPnl: toDecimalString(valuation.realizedPnl, 6),
      realizedPnlInBase: toNullableDecimalString(
        valuation.realizedPnlInBase,
        6,
      ),
      dividendsReceived: toDecimalString(valuation.dividendsReceived, 6),
      dividendsReceivedInBase: toNullableDecimalString(
        valuation.dividendsReceivedInBase,
        6,
      ),

      totalReturn: toNullableDecimalString(valuation.totalReturn, 6),
      totalReturnPercent: toNullableDecimalString(
        valuation.totalReturnPercent,
        2,
      ),
      totalReturnInBase: toNullableDecimalString(
        valuation.totalReturnInBase,
        6,
      ),

      weightPercent: toNullableDecimalString(weight, 2),
      closedTradeCount: group.closedTradeCount,
      winningTradeCount: group.winningTradeCount,
      zeroCostBuyCount: group.zeroCostBuyCount,
    };
  });

  // Unrealized P&L summary compares priced open market value against priced open cost basis
  const totalUnrealizedPnlInBase = totalMarketValueInBase.minus(
    totalCostBasisOfPricedOpenInBase,
  );
  const totalUnrealizedPnlPercent = safeDivide(
    totalUnrealizedPnlInBase.mul(HUNDRED),
    totalCostBasisOfPricedOpenInBase,
  );
  const totalDayChangePercent = safeDivide(
    totalDayChangeInBase.mul(HUNDRED),
    totalPrevDayMarketValueInBase,
  );
  const totalLifetimeReturnInBase = totalUnrealizedPnlInBase
    .plus(totalRealizedPnlInBase)
    .plus(totalDividendsInBase);

  return {
    rows,
    summary: {
      baseCurrency,
      totalMarketValueInBase: toDecimalString(totalMarketValueInBase, 2),
      totalCostBasisInBase: toDecimalString(totalCostBasisAllOpenInBase, 2),
      totalDayChangeInBase: toDecimalString(totalDayChangeInBase, 2),
      totalDayChangePercent: toNullableDecimalString(totalDayChangePercent, 2),
      totalUnrealizedPnlInBase: toDecimalString(totalUnrealizedPnlInBase, 2),
      totalUnrealizedPnlPercent: toNullableDecimalString(
        totalUnrealizedPnlPercent,
        2,
      ),
      totalRealizedPnlInBase: toDecimalString(totalRealizedPnlInBase, 2),
      totalDividendsInBase: toDecimalString(totalDividendsInBase, 2),
      totalLifetimeReturnInBase: toDecimalString(totalLifetimeReturnInBase, 2),
      openCount,
      closedCount,
      unpricedOpenSymbols,
    },
  };
}

