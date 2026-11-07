/**
 * Position and portfolio profit-and-loss (P&L) valuation math.
 *
 * All numbers are derived from `FifoEvaluationResult` plus an explicit quote
 * snapshot. In keeping with Working Rule 5 ("Never fabricate market data"):
 *   - If an instrument is marked `isDelisted` (worthless), its effective price
 *     is `0` unless the user explicitly set a `manualPrice`.
 *   - Else if `manualPrice` is set, that price is used and labelled `"manual"`.
 *   - Else the provider quote is used if present.
 *   - Otherwise price is `null` (`"unavailable"`), and `marketValue`,
 *     `unrealizedPnl`, and `totalReturn` (when open shares exist) remain `null`
 *     rather than silently substituting 0 or cost basis.
 */
import {
  type DecimalInput,
  type DecimalValue,
  HUNDRED,
  QUANTITY_EPSILON,
  safeDivide,
  toOptionalDecimal,
  ZERO,
} from "@/lib/finance/decimal";
import type { FifoEvaluationResult } from "@/lib/finance/fifo";
import { convertCurrencyAmount } from "@/lib/finance/fx";

export type PriceResolutionSource =
  | "live"
  | "delayed"
  | "closed"
  | "stale"
  | "manual"
  | "delisted-worthless"
  | "unavailable";

export interface QuoteSnapshot {
  /** Latest trade or close price in the instrument's native currency. */
  price: DecimalInput | null;
  /** Previous session close in native currency, for day-change calculation. */
  previousClose?: DecimalInput | null;
  freshness?: "live" | "delayed" | "closed" | "stale" | "unavailable";
}

export interface InstrumentPricingContext {
  currency: string;
  manualPrice?: DecimalInput | null;
  isDelisted?: boolean;
  quote?: QuoteSnapshot | null;
  /** Current FX rate (`native -> baseCurrency`) used for live market values. */
  currentFxRateToBase?: DecimalValue | null;
}

export interface PositionValuation {
  isOpenPosition: boolean;
  isClosedPosition: boolean;
  sharesHeld: DecimalValue;
  /** Cost basis of open shares (`openCostBasis`). */
  costBasis: DecimalValue;
  /** Average cost per open share (`costBasis / sharesHeld`), or null if 0 shares. */
  averageCostPerShare: DecimalValue | null;

  /** Effective native price per share, or null when unavailable. */
  unitPrice: DecimalValue | null;
  priceSource: PriceResolutionSource;

  /** `sharesHeld * unitPrice`, or 0 when 0 shares held, or null when unpriced. */
  marketValue: DecimalValue | null;
  /** `(unitPrice - previousClose) * sharesHeld`, or null when unavailable. */
  dayChangeAmount: DecimalValue | null;
  /** `((unitPrice - previousClose) / previousClose) * 100`, or null. */
  dayChangePercent: DecimalValue | null;

  /** `marketValue - costBasis`, or null when open shares lack a price. */
  unrealizedPnl: DecimalValue | null;
  /** `(unrealizedPnl / costBasis) * 100`, or null when `costBasis == 0` or unpriced. */
  unrealizedPnlPercent: DecimalValue | null;

  /** Realized P&L across closed FIFO lot matches (native currency). */
  realizedPnl: DecimalValue;
  /** Net cash (or reinvested) dividends received (native currency). */
  dividendsReceived: DecimalValue;

  /**
   * Total lifetime return in native currency:
   *   `unrealizedPnl + realizedPnl + dividendsReceived`.
   * Null only when open shares are currently held AND cannot be priced.
   */
  totalReturn: DecimalValue | null;
  /** `(totalReturn / totalCapitalInvested) * 100`, or null when invested == 0. */
  totalReturnPercent: DecimalValue | null;

  // Base-currency equivalents (historical FX for cost, current FX for value)
  costBasisInBase: DecimalValue | null;
  marketValueInBase: DecimalValue | null;
  dayChangeInBase: DecimalValue | null;
  unrealizedPnlInBase: DecimalValue | null;
  realizedPnlInBase: DecimalValue | null;
  dividendsReceivedInBase: DecimalValue | null;
  totalReturnInBase: DecimalValue | null;
}

/**
 * Resolves which price (if any) applies to an instrument right now.
 *
 * Priority:
 *   1. User `manualPrice` override (works for both unlisted and delisted assets).
 *   2. `isDelisted === true` -> `0` (`"delisted-worthless"`).
 *   3. Provider quote price (`"live" | "delayed" | "closed" | "stale"`).
 *   4. Otherwise `null` (`"unavailable"`).
 */
export function resolveEffectivePrice(
  context: InstrumentPricingContext,
): { price: DecimalValue | null; source: PriceResolutionSource } {
  const manual = toOptionalDecimal(context.manualPrice);
  if (manual !== null) {
    return { price: manual, source: "manual" };
  }

  if (context.isDelisted) {
    return { price: ZERO, source: "delisted-worthless" };
  }

  const quotePrice = toOptionalDecimal(context.quote?.price);
  if (quotePrice !== null) {
    const freshness = context.quote?.freshness ?? "closed";
    const source: PriceResolutionSource =
      freshness === "unavailable" ? "closed" : freshness;
    return { price: quotePrice, source };
  }

  return { price: null, source: "unavailable" };
}

/**
 * Computes all holding-level valuation and P&L metrics from FIFO output.
 *
 * Formulas in words:
 *   - Average cost per share  = openCostBasis / sharesHeld (when sharesHeld > 0)
 *   - Market value            = sharesHeld * unitPrice
 *   - Day change ($)          = (unitPrice - previousClose) * sharesHeld
 *   - Day change (%)          = ((unitPrice - previousClose) / previousClose) * 100
 *   - Unrealized P&L ($)      = marketValue - openCostBasis
 *   - Unrealized P&L (%)      = (unrealizedPnl / openCostBasis) * 100 (when openCostBasis > 0)
 *   - Total return ($)        = unrealizedPnl + realizedPnl + dividendsReceived
 *   - Total return (%)        = (totalReturn / totalCapitalInvested) * 100
 *   - Base-currency unrealized P&L = (marketValue * currentFx) - openCostBasisAtHistoricalBuyFx
 */
export function computePositionValuation(
  fifo: FifoEvaluationResult,
  pricing: InstrumentPricingContext,
): PositionValuation {
  const isOpenPosition = fifo.sharesHeld.gt(QUANTITY_EPSILON);
  const hadHistoricalActivity =
    fifo.closedLotMatches.length > 0 || fifo.dividends.length > 0;
  const isClosedPosition = !isOpenPosition && hadHistoricalActivity;

  const sharesHeld = isOpenPosition ? fifo.sharesHeld : ZERO;
  const costBasis = isOpenPosition ? fifo.openCostBasis : ZERO;
  const averageCostPerShare = isOpenPosition
    ? safeDivide(costBasis, sharesHeld)
    : null;

  const { price: unitPrice, source: priceSource } =
    resolveEffectivePrice(pricing);
  const previousClose = toOptionalDecimal(pricing.quote?.previousClose);

  let marketValue: DecimalValue | null;
  let unrealizedPnl: DecimalValue | null;
  if (!isOpenPosition) {
    marketValue = ZERO;
    unrealizedPnl = ZERO;
  } else if (unitPrice !== null) {
    marketValue = sharesHeld.mul(unitPrice);
    unrealizedPnl = marketValue.minus(costBasis);
  } else {
    marketValue = null;
    unrealizedPnl = null;
  }

  let dayChangeAmount: DecimalValue | null = null;
  let dayChangePercent: DecimalValue | null = null;
  if (
    unitPrice !== null &&
    previousClose !== null &&
    previousClose.gt(ZERO) &&
    priceSource !== "manual" &&
    priceSource !== "delisted-worthless"
  ) {
    const perShareChange = unitPrice.minus(previousClose);
    dayChangePercent = perShareChange.div(previousClose).mul(HUNDRED);
    dayChangeAmount = isOpenPosition ? perShareChange.mul(sharesHeld) : ZERO;
  }

  const unrealizedPnlPercent =
    unrealizedPnl !== null && costBasis.gt(ZERO)
      ? unrealizedPnl.div(costBasis).mul(HUNDRED)
      : null;

  const totalReturn =
    unrealizedPnl !== null
      ? unrealizedPnl.plus(fifo.realizedPnl).plus(fifo.dividendsReceived)
      : null;

  const totalReturnPercent =
    totalReturn !== null && fifo.totalCapitalInvested.gt(ZERO)
      ? totalReturn.div(fifo.totalCapitalInvested).mul(HUNDRED)
      : null;

  // Base-currency conversions:
  //   - Cost basis uses historical FX locked in on each buy date (`fifo.openCostBasisInBase`).
  //   - Market value and day change use current FX (`pricing.currentFxRateToBase`).
  const currentFx = pricing.currentFxRateToBase ?? null;
  const costBasisInBase = isOpenPosition ? fifo.openCostBasisInBase : ZERO;
  const marketValueInBase = !isOpenPosition
    ? ZERO
    : convertCurrencyAmount(marketValue, currentFx);
  const dayChangeInBase = convertCurrencyAmount(dayChangeAmount, currentFx);

  const unrealizedPnlInBase =
    !isOpenPosition
      ? ZERO
      : marketValueInBase !== null && costBasisInBase !== null
        ? marketValueInBase.minus(costBasisInBase)
        : null;

  const realizedPnlInBase = fifo.realizedPnlInBase;
  const dividendsReceivedInBase = fifo.dividendsReceivedInBase;

  const totalReturnInBase =
    unrealizedPnlInBase !== null &&
    realizedPnlInBase !== null &&
    dividendsReceivedInBase !== null
      ? unrealizedPnlInBase.plus(realizedPnlInBase).plus(dividendsReceivedInBase)
      : null;

  return {
    isOpenPosition,
    isClosedPosition,
    sharesHeld,
    costBasis,
    averageCostPerShare,
    unitPrice,
    priceSource,
    marketValue,
    dayChangeAmount,
    dayChangePercent,
    unrealizedPnl,
    unrealizedPnlPercent,
    realizedPnl: fifo.realizedPnl,
    dividendsReceived: fifo.dividendsReceived,
    totalReturn,
    totalReturnPercent,
    costBasisInBase,
    marketValueInBase,
    dayChangeInBase,
    unrealizedPnlInBase,
    realizedPnlInBase,
    dividendsReceivedInBase,
    totalReturnInBase,
  };
}

/**
 * Computes each position's percentage weight in the portfolio.
 *
 * Formula in words:
 *   weightPercent = (positionMarketValue / sumOfPricedOpenMarketValues) * 100
 * Returns `null` for closed or unpriced positions, or when total value is zero.
 */
export function computePortfolioWeights(
  marketValues: readonly (DecimalValue | null)[],
): (DecimalValue | null)[] {
  let totalValue = ZERO;
  for (const value of marketValues) {
    if (value !== null && value.gt(ZERO)) {
      totalValue = totalValue.plus(value);
    }
  }

  if (!totalValue.gt(ZERO)) {
    return marketValues.map(() => null);
  }

  return marketValues.map((value) => {
    if (value === null) {
      return null;
    }
    if (value.isZero()) {
      return ZERO;
    }
    if (value.isNegative()) {
      return null;
    }
    return value.div(totalValue).mul(HUNDRED);
  });
}
