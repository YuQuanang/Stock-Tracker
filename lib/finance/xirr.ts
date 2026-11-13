/**
 * Money-Weighted Rate of Return (XIRR) for irregular investment cash flows.
 *
 * Unlike Time-Weighted Return (TWR), XIRR accounts for both the timing and
 * dollar size of every deposit, withdrawal, and dividend, reflecting the
 * investor's actual dollar-weighted compounding rate.
 */
import { type DecimalInput, type DecimalValue, toDecimal } from "@/lib/finance/decimal";

export interface XirrCashFlow {
  /** Calendar date in `YYYY-MM-DD` format. */
  date: string;
  /**
   * Signed cash flow from the investor's perspective:
   *  - Negative: money put IN to the portfolio (Buy cost + commission).
   *  - Positive: money taken OUT (Sell proceeds net of commission, cash dividends,
   *              and the final terminal portfolio value on the valuation date).
   */
  amount: DecimalInput;
}

/** Converts `YYYY-MM-DD` to integer UTC days since the Unix epoch. */
export function isoDateToEpochDays(isoDate: string): number {
  const [year, month, day] = isoDate.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

/**
 * Evaluates Net Present Value `NPV(rate)` and its derivative `dNPV/dRate`:
 *
 *   NPV(r) = sum_i( amount_i / (1 + r)^((t_i - t_0) / 365) )
 */
function evaluateNpvAndDerivative(
  flows: readonly { amount: number; yearsFromStart: number }[],
  rate: number,
): { npv: number; derivative: number } {
  const base = 1 + rate;
  if (base <= 0) {
    return { npv: Number.NaN, derivative: Number.NaN };
  }

  let npv = 0;
  let derivative = 0;

  for (const flow of flows) {
    const t = flow.yearsFromStart;
    const discount = Math.pow(base, t);
    npv += flow.amount / discount;
    if (t !== 0) {
      derivative -= (t * flow.amount) / (discount * base);
    }
  }

  return { npv, derivative };
}

/**
 * Computes the annualized internal rate of return (XIRR) using safeguarded
 * Newton-Raphson with bracketed bisection fallback.
 *
 * Formula in words:
 *   Finds the annual rate `r` (returned as a decimal fraction, e.g. `0.125` for
 *   12.5%) such that the sum of all discounted cash flows equals zero:
 *     sum_i( amount_i / (1 + r)^((date_i - date_0) / 365) ) = 0
 *
 * Returns `null` when cash flows do not span at least 1 day, lack both positive
 * and negative amounts, or fail to converge to a finite real root.
 */
export function computeXirr(
  cashFlows: readonly XirrCashFlow[],
): DecimalValue | null {
  const cleaned = cashFlows
    .map((flow) => ({
      dayNumber: isoDateToEpochDays(flow.date),
      amount: toDecimal(flow.amount).toNumber(),
    }))
    .filter((flow) => Number.isFinite(flow.dayNumber) && Math.abs(flow.amount) > 1e-10)
    .sort((a, b) => a.dayNumber - b.dayNumber);

  if (cleaned.length < 2) {
    return null;
  }

  let hasPositive = false;
  let hasNegative = false;
  for (const flow of cleaned) {
    if (flow.amount > 0) hasPositive = true;
    if (flow.amount < 0) hasNegative = true;
  }
  if (!hasPositive || !hasNegative) {
    return null;
  }

  const minDay = cleaned[0].dayNumber;
  const maxDay = cleaned[cleaned.length - 1].dayNumber;
  const totalSpanDays = maxDay - minDay;
  if (totalSpanDays < 1) {
    return null;
  }

  const normalized = cleaned.map((flow) => ({
    amount: flow.amount,
    yearsFromStart: (flow.dayNumber - minDay) / 365,
  }));

  // Guard ultra-short windows (< 14 days) only against astronomical blow-ups (> 10,000%).
  const MAX_RATE = 50.0;
  const MIN_RATE = -0.9999;
  const TOLERANCE = 1e-7;

  // Attempt Newton-Raphson first from reasonable seed guesses.
  for (const initialGuess of [0.1, 0.0, -0.2, 0.5]) {
    let rate = initialGuess;
    for (let iter = 0; iter < 80; iter += 1) {
      const { npv, derivative } = evaluateNpvAndDerivative(normalized, rate);
      if (!Number.isFinite(npv)) {
        break;
      }
      if (Math.abs(npv) < TOLERANCE) {
        return toDecimal(rate).toDecimalPlaces(8);
      }
      if (!Number.isFinite(derivative) || Math.abs(derivative) < 1e-12) {
        break;
      }
      const nextRate = rate - npv / derivative;
      if (nextRate <= MIN_RATE || nextRate > MAX_RATE || !Number.isFinite(nextRate)) {
        break;
      }
      if (Math.abs(nextRate - rate) < TOLERANCE) {
        return toDecimal(nextRate).toDecimalPlaces(8);
      }
      rate = nextRate;
    }
  }

  // Fallback: scan logarithmically spaced brackets for a sign change, then bisect.
  const probePoints = [
    MIN_RATE,
    -0.95,
    -0.8,
    -0.5,
    -0.25,
    -0.1,
    0,
    0.05,
    0.15,
    0.35,
    0.75,
    1.5,
    3,
    6,
    15,
    MAX_RATE,
  ];

  let low = Number.NaN;
  let high = Number.NaN;
  let npvLow = Number.NaN;

  for (let i = 0; i < probePoints.length - 1; i += 1) {
    const a = probePoints[i];
    const b = probePoints[i + 1];
    const fa = evaluateNpvAndDerivative(normalized, a).npv;
    const fb = evaluateNpvAndDerivative(normalized, b).npv;
    if (!Number.isFinite(fa) || !Number.isFinite(fb)) {
      continue;
    }
    if (Math.abs(fa) < TOLERANCE) {
      return toDecimal(a).toDecimalPlaces(8);
    }
    if (Math.abs(fb) < TOLERANCE) {
      return toDecimal(b).toDecimalPlaces(8);
    }
    if ((fa > 0 && fb < 0) || (fa < 0 && fb > 0)) {
      low = a;
      high = b;
      npvLow = fa;
      break;
    }
  }

  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    return null;
  }

  for (let iter = 0; iter < 120; iter += 1) {
    const mid = (low + high) / 2;
    const npvMid = evaluateNpvAndDerivative(normalized, mid).npv;
    if (!Number.isFinite(npvMid)) {
      return null;
    }
    if (Math.abs(npvMid) < TOLERANCE || Math.abs(high - low) < TOLERANCE) {
      return toDecimal(mid).toDecimalPlaces(8);
    }
    if ((npvLow > 0 && npvMid > 0) || (npvLow < 0 && npvMid < 0)) {
      low = mid;
      npvLow = npvMid;
    } else {
      high = mid;
    }
  }

  return toDecimal((low + high) / 2).toDecimalPlaces(8);
}

