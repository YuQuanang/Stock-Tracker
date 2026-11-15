/**
 * Time-Weighted Return (TWR), Compound Annual Growth Rate (CAGR), and calendar
 * period return calculations.
 *
 * TWR removes the distortion caused by the timing and size of external deposits
 * and withdrawals so you can compare your investment skill fairly against
 * market indices (`^GSPC`, `^IXIC`, `^DJI`, `^STI`).
 */
import {
  type DecimalInput,
  type DecimalValue,
  HUNDRED,
  ONE,
  QUANTITY_EPSILON,
  safeDivide,
  toDecimal,
  ZERO,
} from "@/lib/finance/decimal";
import { isoDateToEpochDays } from "@/lib/finance/xirr";

const HALF = toDecimal("0.5");

export type PeriodReturnKey =
  | "1D"
  | "1W"
  | "1M"
  | "3M"
  | "6M"
  | "YTD"
  | "1Y"
  | "3Y"
  | "5Y"
  | "ALL";

export interface TwrDailyInput {
  /** Calendar date (`YYYY-MM-DD`). */
  date: string;
  /** End-of-day portfolio market value in the chosen base currency. */
  portfolioValue: DecimalInput;
  /**
   * Net external capital flow added on this date (`Buys cost - Sell proceeds`).
   * Positive = net cash injected; negative = net cash withdrawn.
   */
  externalCashFlow: DecimalInput;
  /** Cash dividends paid out on this date (included in total return). */
  dividendInflow?: DecimalInput;
}

export interface TwrDailyPoint {
  date: string;
  portfolioValue: DecimalValue;
  externalCashFlow: DecimalValue;
  dividendInflow: DecimalValue;
  /** Sub-period return as a decimal fraction (e.g. `0.015` = +1.5%). */
  dailyReturn: DecimalValue;
  /** Growth of 100 invested at inception (rebased TWR curve). */
  cumulativeIndex: DecimalValue;
  /** Whether the portfolio held active invested capital or cash flows on this day. */
  isActiveDay: boolean;
}

export interface TwrResult {
  points: TwrDailyPoint[];
  /** Cumulative TWR as a fraction (`(endIndex / 100) - 1`). */
  cumulativeReturn: DecimalValue | null;
  cumulativeReturnPercent: DecimalValue | null;
  /** Annualized TWR (`CAGR` across `[firstActiveDate .. lastDate]`). */
  annualizedReturn: DecimalValue | null;
  annualizedReturnPercent: DecimalValue | null;
  firstActiveDate: string | null;
  lastDate: string | null;
}

/**
 * Computes CAGR from a cumulative return fraction and calendar date bounds.
 *
 * Formula in words:
 *   CAGR = (1 + cumulativeReturn)^(365.25 / calendarDays) - 1
 */
export function computeCagr(
  cumulativeReturnFraction: DecimalInput | null,
  startDate: string,
  endDate: string,
): DecimalValue | null {
  if (cumulativeReturnFraction === null) {
    return null;
  }
  const cum = toDecimal(cumulativeReturnFraction);
  const days = isoDateToEpochDays(endDate) - isoDateToEpochDays(startDate);
  if (days < 14) {
    // Annualizing periods shorter than 2 weeks produces extreme noise.
    return null;
  }
  const gross = ONE.plus(cum).toNumber();
  if (!Number.isFinite(gross) || gross <= 0) {
    return null;
  }
  const cagr = Math.pow(gross, 365.25 / days) - 1;
  if (!Number.isFinite(cagr)) {
    return null;
  }
  return toDecimal(cagr).toDecimalPlaces(8);
}

/**
 * Links daily sub-period returns into a continuous unitized Time-Weighted
 * Return curve rebased to `100` at inception.
 *
 * Formulas in words:
 *   - No flow day (`CF_t = 0`, `V_{t-1} > 0`):
 *       `r_t = (V_t + Dividend_t) / V_{t-1} - 1`
 *   - Opening entry (`V_{t-1} = 0`, `CF_t > 0`):
 *       `r_t = (V_t + Dividend_t - CF_t) / CF_t`
 *   - Full exit (`V_{t-1} > 0`, `V_t = 0`, `CF_t < 0`):
 *       `r_t = (-CF_t + Dividend_t - V_{t-1}) / V_{t-1}`
 *   - Mixed cashflow day (`V_{t-1} > 0`, `V_t > 0`, `CF_t != 0`):
 *       Modified Dietz daily approximation:
 *       `r_t = (V_t + Dividend_t - V_{t-1} - CF_t) / (V_{t-1} + 0.5 * CF_t)`
 *   - Cumulative index:
 *       `Index_t = 100 * product_{i <= t}(1 + r_i)`
 */
export function computeTimeWeightedReturn(
  dailyInputs: readonly TwrDailyInput[],
): TwrResult {
  if (dailyInputs.length === 0) {
    return {
      points: [],
      cumulativeReturn: null,
      cumulativeReturnPercent: null,
      annualizedReturn: null,
      annualizedReturnPercent: null,
      firstActiveDate: null,
      lastDate: null,
    };
  }

  const sorted = [...dailyInputs].sort((a, b) => a.date.localeCompare(b.date));
  const points: TwrDailyPoint[] = [];

  let cumulativeFactor = ONE;
  let prevValue = ZERO;
  let firstActiveDate: string | null = null;
  let lastActiveValueDate: string | null = null;

  for (const row of sorted) {
    const val = toDecimal(row.portfolioValue);
    const cf = toDecimal(row.externalCashFlow);
    const div = toDecimal(row.dividendInflow ?? 0);

    const hasPrev = prevValue.gt(QUANTITY_EPSILON);
    const hasCurr = val.gt(QUANTITY_EPSILON);
    const hasFlow = cf.abs().gt(QUANTITY_EPSILON);
    const isActiveDay = hasPrev || hasCurr || hasFlow || div.gt(ZERO);

    if (isActiveDay && firstActiveDate === null) {
      firstActiveDate = row.date;
    }
    if (hasCurr) {
      lastActiveValueDate = row.date;
    }

    let dailyReturn = ZERO;

    if (!hasPrev && hasFlow && cf.gt(ZERO)) {
      // Day 1 / re-entry day: capital deployed on `row.date`.
      dailyReturn = safeDivide(val.plus(div).minus(cf), cf) ?? ZERO;
    } else if (hasPrev && !hasCurr && hasFlow && cf.lt(ZERO)) {
      // Full liquidation day: proceeds left the equity book.
      dailyReturn =
        safeDivide(cf.negated().plus(div).minus(prevValue), prevValue) ?? ZERO;
    } else if (hasPrev && !hasFlow) {
      // Pure market movement + dividends with zero external cash flow.
      dailyReturn =
        safeDivide(val.plus(div).minus(prevValue), prevValue) ?? ZERO;
    } else if (hasPrev && hasFlow) {
      const dietzDenom = prevValue.plus(cf.mul(HALF));
      const startDayDenom = prevValue.plus(cf);
      const denominator = dietzDenom.gt(QUANTITY_EPSILON)
        ? dietzDenom
        : startDayDenom;
      if (denominator.gt(QUANTITY_EPSILON)) {
        dailyReturn =
          safeDivide(
            val.plus(div).minus(prevValue).minus(cf),
            denominator,
          ) ?? ZERO;
      }
    }

    // Clamp single-day return safely above -99.99% to keep chained product well-defined.
    const minReturn = toDecimal("-0.9999");
    if (dailyReturn.lt(minReturn)) {
      dailyReturn = minReturn;
    }

    cumulativeFactor = cumulativeFactor.mul(ONE.plus(dailyReturn));
    const cumulativeIndex = cumulativeFactor.mul(HUNDRED);

    points.push({
      date: row.date,
      portfolioValue: val,
      externalCashFlow: cf,
      dividendInflow: div,
      dailyReturn: dailyReturn.toDecimalPlaces(8),
      cumulativeIndex: cumulativeIndex.toDecimalPlaces(6),
      isActiveDay,
    });

    prevValue = val;
  }

  if (firstActiveDate === null) {
    return {
      points,
      cumulativeReturn: null,
      cumulativeReturnPercent: null,
      annualizedReturn: null,
      annualizedReturnPercent: null,
      firstActiveDate: null,
      lastDate: sorted[sorted.length - 1]?.date ?? null,
    };
  }

  const lastDate =
    lastActiveValueDate ?? sorted[sorted.length - 1]?.date ?? firstActiveDate;
  const cumulativeReturn = cumulativeFactor.minus(ONE).toDecimalPlaces(8);
  const cumulativeReturnPercent = cumulativeReturn
    .mul(HUNDRED)
    .toDecimalPlaces(2);

  const annualizedReturn = computeCagr(
    cumulativeReturn,
    firstActiveDate,
    lastDate,
  );
  const annualizedReturnPercent = annualizedReturn
    ? annualizedReturn.mul(HUNDRED).toDecimalPlaces(2)
    : null;

  return {
    points,
    cumulativeReturn,
    cumulativeReturnPercent,
    annualizedReturn,
    annualizedReturnPercent,
    firstActiveDate,
    lastDate,
  };
}

function addCalendarOffset(
  isoDate: string,
  delta: { days?: number; months?: number; years?: number },
): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(
    Date.UTC(
      y + (delta.years ?? 0),
      m - 1 + (delta.months ?? 0),
      d + (delta.days ?? 0),
    ),
  );
  const year = dt.getUTCFullYear();
  const month = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(dt.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Computes percentage returns over standard horizons (`1D`, `1W`, `1M`, `3M`,
 * `6M`, `YTD`, `1Y`, `3Y`, `5Y`, `ALL`) from any monotonic cumulative index/price series.
 *
 * Formula in words:
 *   `return(H) = ((index_end / index_anchor) - 1) * 100`
 * where `index_anchor` is the latest point on or before the horizon's start
 * boundary (or the preceding trading point for `1D`).
 */
export function computeHorizonReturns(
  series: readonly { date: string; value: DecimalInput }[],
  asOfDate?: string,
  options?: { allBaseValue?: DecimalInput },
): Record<PeriodReturnKey, DecimalValue | null> {
  const sorted = [...series]
    .filter((pt) => toDecimal(pt.value).gt(ZERO))
    .sort((a, b) => a.date.localeCompare(b.date));

  const empty: Record<PeriodReturnKey, DecimalValue | null> = {
    "1D": null,
    "1W": null,
    "1M": null,
    "3M": null,
    "6M": null,
    YTD: null,
    "1Y": null,
    "3Y": null,
    "5Y": null,
    ALL: null,
  };

  if (sorted.length < 2) {
    return empty;
  }

  const endPoint = asOfDate
    ? sorted.filter((p) => p.date <= asOfDate).at(-1)
    : sorted.at(-1);
  if (!endPoint) {
    return empty;
  }

  const endValue = toDecimal(endPoint.value);
  const endDate = endPoint.date;
  const endIdx = sorted.findIndex((p) => p.date === endDate);

  function pctFromAnchor(anchorPoint: { value: DecimalInput } | undefined): DecimalValue | null {
    if (!anchorPoint) {
      return null;
    }
    const startVal = toDecimal(anchorPoint.value);
    if (!startVal.gt(ZERO)) {
      return null;
    }
    const pct = safeDivide(endValue.minus(startVal).mul(HUNDRED), startVal);
    return pct ? pct.toDecimalPlaces(2) : null;
  }

  function findLatestOnOrBefore(targetDate: string) {
    let matched: (typeof sorted)[number] | undefined;
    for (let i = 0; i <= endIdx; i += 1) {
      if (sorted[i].date <= targetDate) {
        matched = sorted[i];
      } else {
        break;
      }
    }
    // If history starts slightly after targetDate (within 5 calendar days), allow
    // the earliest point ONLY when targetDate is NOT prior to inception for fixed periods.
    return matched;
  }

  const oneDayPrev = endIdx >= 1 ? sorted[endIdx - 1] : undefined;
  const inceptionDate = sorted[0].date;

  function resolveHorizon(targetDate: string): DecimalValue | null {
    if (targetDate < inceptionDate) {
      // Series wasn't alive at horizon start (except YTD if started on first trading day of year)
      return null;
    }
    return pctFromAnchor(findLatestOnOrBefore(targetDate));
  }

  const ytdAnchorDate = `${endDate.slice(0, 4)}-01-01`;
  // YTD is meaningful if portfolio was active before or at start of the current year.
  const ytdAnchor =
    inceptionDate <= `${endDate.slice(0, 4)}-01-07`
      ? findLatestOnOrBefore(ytdAnchorDate) ?? sorted[0]
      : undefined;

  return {
    "1D": pctFromAnchor(oneDayPrev),
    "1W": resolveHorizon(addCalendarOffset(endDate, { days: -7 })),
    "1M": resolveHorizon(addCalendarOffset(endDate, { months: -1 })),
    "3M": resolveHorizon(addCalendarOffset(endDate, { months: -3 })),
    "6M": resolveHorizon(addCalendarOffset(endDate, { months: -6 })),
    YTD: pctFromAnchor(ytdAnchor),
    "1Y": resolveHorizon(addCalendarOffset(endDate, { years: -1 })),
    "3Y": resolveHorizon(addCalendarOffset(endDate, { years: -3 })),
    "5Y": resolveHorizon(addCalendarOffset(endDate, { years: -5 })),
    ALL: pctFromAnchor(
      options?.allBaseValue !== undefined
        ? { value: options.allBaseValue }
        : sorted[0],
    ),
  };
}
