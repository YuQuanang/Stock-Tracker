/**
 * Stock-split adjustment helpers for open FIFO lots.
 *
 * Stored transactions are immutable — we never rewrite historical quantities
 * or prices in the database. Instead, as the FIFO engine walks forward in time
 * and crosses a split's `exDate`, every open lot held prior to `exDate` has its
 * share count scaled by the split ratio while its total cost basis stays
 * unchanged.
 */
import { type DecimalValue, safeDivide, toDecimal, ZERO } from "@/lib/finance/decimal";

export interface SplitAction {
  id: string;
  /** Ex-split date in `YYYY-MM-DD` format. */
  exDate: string;
  /** For a 2-for-1 split, `ratioNumerator = 2` and `ratioDenominator = 1`. */
  ratioNumerator: number;
  ratioDenominator: number;
}

export interface SplittableLot {
  remainingShares: DecimalValue;
  initialShares: DecimalValue;
  remainingCostBasis: DecimalValue;
  costPerShare: DecimalValue;
}

/**
 * Applies a stock split (`ratioNumerator : ratioDenominator`) to an open lot in
 * place.
 *
 * Formula in words:
 *   splitFactor        = ratioNumerator / ratioDenominator
 *   newRemainingShares = remainingShares * splitFactor
 *   newCostPerShare    = remainingCostBasis / newRemainingShares
 *   remainingCostBasis = unchanged (a split does not create or destroy cost).
 */
export function applySplitToOpenLot(
  lot: SplittableLot,
  split: SplitAction,
): void {
  const numerator = toDecimal(split.ratioNumerator);
  const denominator = toDecimal(split.ratioDenominator);

  if (!numerator.gt(ZERO) || !denominator.gt(ZERO)) {
    throw new Error(
      `Invalid split ratio ${split.ratioNumerator}:${split.ratioDenominator} on ${split.exDate}.`,
    );
  }

  const splitFactor = numerator.div(denominator);
  lot.remainingShares = lot.remainingShares.mul(splitFactor);
  lot.initialShares = lot.initialShares.mul(splitFactor);
  lot.costPerShare =
    safeDivide(lot.remainingCostBasis, lot.remainingShares) ?? lot.costPerShare;
}
