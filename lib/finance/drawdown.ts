/**
 * Peak-to-trough Drawdown Analysis.
 *
 * Tracks the running historical high-water mark of a rebased index (such as TWR)
 * and measures every decline from that peak until a new high is reached.
 */
import {
  type DecimalInput,
  type DecimalValue,
  HUNDRED,
  safeDivide,
  toDecimal,
  ZERO,
} from "@/lib/finance/decimal";

export interface DrawdownPoint {
  date: string;
  value: DecimalValue;
  runningPeak: DecimalValue;
  /** Non-positive percentage decline from peak (`0` at highs, `-24.50` at -24.5%). */
  drawdownPercent: DecimalValue;
}

export interface DrawdownSummary {
  points: DrawdownPoint[];
  /** Most severe percentage drop experienced (`<= 0`, e.g. `-24.35`). */
  maxDrawdownPercent: DecimalValue | null;
  /** Date of the peak immediately preceding the maximum drawdown. */
  peakDate: string | null;
  /** Date of the lowest trough within the maximum drawdown episode. */
  troughDate: string | null;
  /** First date after `troughDate` where index recovered to `>= peak`, or `null`. */
  recoveryDate: string | null;
  /** Drawdown percentage at the final point in the series (`0` if at all-time high). */
  currentDrawdownPercent: DecimalValue | null;
}

/**
 * Computes running drawdown underwater points, maximum drawdown, and its exact
 * peak / trough / recovery dates.
 *
 * Formula in words:
 *   `runningPeak_t = max_{s <= t}(index_s)`
 *   `drawdown_t    = ((index_t - runningPeak_t) / runningPeak_t) * 100`
 */
export function computeDrawdownSeries(
  series: readonly { date: string; value: DecimalInput }[],
): DrawdownSummary {
  const sorted = [...series]
    .map((pt) => ({ date: pt.date, value: toDecimal(pt.value) }))
    .filter((pt) => pt.value.gt(ZERO))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (sorted.length === 0) {
    return {
      points: [],
      maxDrawdownPercent: null,
      peakDate: null,
      troughDate: null,
      recoveryDate: null,
      currentDrawdownPercent: null,
    };
  }

  const points: DrawdownPoint[] = [];
  let runningPeak = sorted[0].value;
  let runningPeakDate = sorted[0].date;

  let maxDrawdownPercent = ZERO;
  let maxPeakDate = sorted[0].date;
  let maxPeakValue = sorted[0].value;
  let maxTroughDate = sorted[0].date;
  let troughIndex = 0;

  for (let i = 0; i < sorted.length; i += 1) {
    const pt = sorted[i];
    if (pt.value.gt(runningPeak)) {
      runningPeak = pt.value;
      runningPeakDate = pt.date;
    }

    const drawdownFraction =
      safeDivide(pt.value.minus(runningPeak), runningPeak) ?? ZERO;
    const drawdownPercent = drawdownFraction
      .mul(HUNDRED)
      .toDecimalPlaces(4);

    points.push({
      date: pt.date,
      value: pt.value,
      runningPeak,
      drawdownPercent,
    });

    if (drawdownPercent.lt(maxDrawdownPercent)) {
      maxDrawdownPercent = drawdownPercent;
      maxPeakDate = runningPeakDate;
      maxPeakValue = runningPeak;
      maxTroughDate = pt.date;
      troughIndex = i;
    }
  }

  let recoveryDate: string | null = null;
  if (maxDrawdownPercent.lt(ZERO)) {
    for (let i = troughIndex + 1; i < sorted.length; i += 1) {
      if (sorted[i].value.gte(maxPeakValue)) {
        recoveryDate = sorted[i].date;
        break;
      }
    }
  }

  const lastPoint = points[points.length - 1];
  return {
    points,
    maxDrawdownPercent: maxDrawdownPercent.toDecimalPlaces(2),
    peakDate: maxDrawdownPercent.lt(ZERO) ? maxPeakDate : null,
    troughDate: maxDrawdownPercent.lt(ZERO) ? maxTroughDate : null,
    recoveryDate,
    currentDrawdownPercent: lastPoint
      ? lastPoint.drawdownPercent.toDecimalPlaces(2)
      : null,
  };
}

