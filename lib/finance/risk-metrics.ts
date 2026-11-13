/**
 * Portfolio Risk, Benchmark Regression, Period Extremes & "Same Cash Flows into
 * Benchmark" Simulator (`lib/finance/risk-metrics.ts`).
 */
import {
  type DecimalInput,
  type DecimalValue,
  HUNDRED,
  ONE,
  QUANTITY_EPSILON,
  safeDivide,
  toDecimal,
  toDecimalString,
  ZERO,
} from "@/lib/finance/decimal";

const TRADING_DAYS_PER_YEAR = 252;

export interface DailyReturnPoint {
  date: string;
  /** Daily return as a decimal fraction (e.g. `0.012` = +1.2%). */
  dailyReturn: DecimalInput;
}

export interface PeriodExtreme {
  /** Calendar date (`YYYY-MM-DD`) or month (`YYYY-MM`). */
  period: string;
  /** Signed return percentage (e.g. `5.42` or `-4.18`). */
  percent: DecimalValue;
}

export interface BestWorstPeriodsSummary {
  bestDay: PeriodExtreme | null;
  worstDay: PeriodExtreme | null;
  bestMonth: PeriodExtreme | null;
  worstMonth: PeriodExtreme | null;
}

export interface BenchmarkRegressionResult {
  sampleSize: number;
  /** Pearson correlation `r` in `[-1, 1]`. */
  correlation: DecimalValue | null;
  /** CAPM slope `beta = Cov(Rp, Rb) / Var(Rb)`. */
  beta: DecimalValue | null;
  /**
   * Annualized Jensen's alpha as a percentage (`alpha * 100`):
   *   `alpha = (Rp_ann - Rf) - beta * (Rb_ann - Rf)`
   */
  alphaPercent: DecimalValue | null;
}

/**
 * Computes annualized return volatility (standard deviation of daily returns
 * scaled by `sqrt(252)`), returned as a percentage (e.g. `"18.40"` = 18.40%).
 *
 * Formula in words:
 *   `volatility = sampleStdDev(dailyReturns) * sqrt(252)`
 */
export function computeAnnualizedVolatility(
  dailyReturns: readonly DailyReturnPoint[],
): DecimalValue | null {
  const values = dailyReturns
    .map((pt) => toDecimal(pt.dailyReturn).toNumber())
    .filter((v) => Number.isFinite(v));

  if (values.length < 2) {
    return null;
  }

  const mean = values.reduce((acc, v) => acc + v, 0) / values.length;
  let sumSquaredDiffs = 0;
  for (const v of values) {
    const diff = v - mean;
    sumSquaredDiffs += diff * diff;
  }
  const sampleVariance = sumSquaredDiffs / (values.length - 1);
  if (!Number.isFinite(sampleVariance) || sampleVariance < 0) {
    return null;
  }

  const annVol = Math.sqrt(sampleVariance) * Math.sqrt(TRADING_DAYS_PER_YEAR);
  return toDecimal(annVol).mul(HUNDRED).toDecimalPlaces(2);
}

/**
 * Computes the annualized Sharpe Ratio:
 *
 * Formula in words:
 *   `Sharpe = (annualizedPortfolioReturn - riskFreeRate) / annualizedVolatility`
 *
 * All rates are decimal fractions (e.g. `0.035` risk-free = 3.5%), or if you pass
 * `annualizedVolatilityPercent` (`18.40`), it converts cleanly via `/ 100`.
 */
export function computeSharpeRatio(params: {
  annualizedReturnFraction: DecimalInput | null;
  annualizedVolatilityPercent: DecimalInput | null;
  riskFreeRateFraction: DecimalInput;
}): DecimalValue | null {
  if (
    params.annualizedReturnFraction === null ||
    params.annualizedVolatilityPercent === null
  ) {
    return null;
  }
  const ret = toDecimal(params.annualizedReturnFraction);
  const volFraction = toDecimal(params.annualizedVolatilityPercent).div(HUNDRED);
  const rf = toDecimal(params.riskFreeRateFraction);

  if (!volFraction.gt(QUANTITY_EPSILON)) {
    return null;
  }
  return safeDivide(ret.minus(rf), volFraction)?.toDecimalPlaces(2) ?? null;
}

/**
 * Computes Beta, Pearson Correlation, and annualized Jensen's Alpha against
 * a benchmark return series over overlapping trading dates.
 *
 * Formulas in words:
 *   - Correlation `r`  = Cov(Rp, Rb) / (StdDev(Rp) * StdDev(Rb))
 *   - Beta `β`         = Cov(Rp, Rb) / Var(Rb)
 *   - Jensen Alpha `α` = (AnnReturn_p - Rf) - β * (AnnReturn_b - Rf)
 */
export function computeBenchmarkRegression(params: {
  portfolioReturns: readonly DailyReturnPoint[];
  benchmarkReturns: readonly DailyReturnPoint[];
  portfolioAnnualizedReturn?: DecimalInput | null;
  benchmarkAnnualizedReturn?: DecimalInput | null;
  riskFreeRateFraction?: DecimalInput;
}): BenchmarkRegressionResult {
  const benchByDate = new Map<string, number>();
  for (const pt of params.benchmarkReturns) {
    const val = toDecimal(pt.dailyReturn).toNumber();
    if (Number.isFinite(val)) {
      benchByDate.set(pt.date, val);
    }
  }

  const paired: { rp: number; rb: number }[] = [];
  for (const pt of params.portfolioReturns) {
    const rb = benchByDate.get(pt.date);
    const rp = toDecimal(pt.dailyReturn).toNumber();
    if (rb !== undefined && Number.isFinite(rp)) {
      paired.push({ rp, rb });
    }
  }

  if (paired.length < 5) {
    return {
      sampleSize: paired.length,
      correlation: null,
      beta: null,
      alphaPercent: null,
    };
  }

  const n = paired.length;
  const meanP = paired.reduce((sum, x) => sum + x.rp, 0) / n;
  const meanB = paired.reduce((sum, x) => sum + x.rb, 0) / n;

  let covSum = 0;
  let varPSum = 0;
  let varBSum = 0;
  for (const x of paired) {
    const dp = x.rp - meanP;
    const db = x.rb - meanB;
    covSum += dp * db;
    varPSum += dp * dp;
    varBSum += db * db;
  }

  if (varBSum <= 1e-14 || varPSum <= 1e-14) {
    return {
      sampleSize: n,
      correlation: null,
      beta: null,
      alphaPercent: null,
    };
  }

  const cov = covSum / (n - 1);
  const varP = varPSum / (n - 1);
  const varB = varBSum / (n - 1);

  const betaNum = cov / varB;
  const corrNum = cov / Math.sqrt(varP * varB);
  const clampedCorr = Math.max(-1, Math.min(1, corrNum));

  const beta = toDecimal(betaNum).toDecimalPlaces(2);
  const correlation = toDecimal(clampedCorr).toDecimalPlaces(2);

  let alphaPercent: DecimalValue | null = null;
  if (
    params.portfolioAnnualizedReturn !== null &&
    params.portfolioAnnualizedReturn !== undefined &&
    params.benchmarkAnnualizedReturn !== null &&
    params.benchmarkAnnualizedReturn !== undefined
  ) {
    const rf = toDecimal(params.riskFreeRateFraction ?? 0);
    const rpAnn = toDecimal(params.portfolioAnnualizedReturn);
    const rbAnn = toDecimal(params.benchmarkAnnualizedReturn);
    const alphaFraction = rpAnn.minus(rf).minus(beta.mul(rbAnn.minus(rf)));
    alphaPercent = alphaFraction.mul(HUNDRED).toDecimalPlaces(2);
  }

  return {
    sampleSize: n,
    correlation,
    beta,
    alphaPercent,
  };
}

/**
 * Finds the best/worst single trading day and best/worst compounded calendar month.
 *
 * Formula in words:
 *   For each calendar month `YYYY-MM`:
 *     `monthlyReturn = product_{d in month}(1 + r_d) - 1`
 */
export function computeBestWorstPeriods(
  dailyReturns: readonly DailyReturnPoint[],
): BestWorstPeriodsSummary {
  if (dailyReturns.length === 0) {
    return {
      bestDay: null,
      worstDay: null,
      bestMonth: null,
      worstMonth: null,
    };
  }

  const sorted = [...dailyReturns].sort((a, b) => a.date.localeCompare(b.date));

  let bestDay: PeriodExtreme | null = null;
  let worstDay: PeriodExtreme | null = null;
  const monthCompound = new Map<string, DecimalValue>();

  for (const pt of sorted) {
    const r = toDecimal(pt.dailyReturn);
    const pct = r.mul(HUNDRED).toDecimalPlaces(2);

    if (bestDay === null || pct.gt(bestDay.percent)) {
      bestDay = { period: pt.date, percent: pct };
    }
    if (worstDay === null || pct.lt(worstDay.percent)) {
      worstDay = { period: pt.date, percent: pct };
    }

    const monthKey = pt.date.slice(0, 7);
    const prevFactor = monthCompound.get(monthKey) ?? ONE;
    monthCompound.set(monthKey, prevFactor.mul(ONE.plus(r)));
  }

  let bestMonth: PeriodExtreme | null = null;
  let worstMonth: PeriodExtreme | null = null;

  for (const [month, factor] of monthCompound.entries()) {
    const pct = factor.minus(ONE).mul(HUNDRED).toDecimalPlaces(2);
    if (bestMonth === null || pct.gt(bestMonth.percent)) {
      bestMonth = { period: month, percent: pct };
    }
    if (worstMonth === null || pct.lt(worstMonth.percent)) {
      worstMonth = { period: month, percent: pct };
    }
  }

  return { bestDay, worstDay, bestMonth, worstMonth };
}

export interface ExternalCashFlowEvent {
  date: string;
  /**
   * Net cash contributed on `date` in `baseCurrency`:
   *  - Positive = Buy cost (+ commission) invested into the portfolio
   *  - Negative = Sell proceeds (- commission) or cash dividends withdrawn
   */
  netFlow: DecimalInput;
}

export interface SameCashFlowsPoint {
  date: string;
  portfolioValue: string;
  benchmarkValue: string;
  netContributed: string;
}

export interface SameCashFlowsSimulationResult {
  benchmarkSymbol: string;
  dailySeries: SameCashFlowsPoint[];
  totalDeposited: string;
  totalWithdrawn: string;
  netContributed: string;
  portfolioFinalValue: string;
  portfolioTotalGain: string;
  portfolioTotalGainPercent: string | null;
  benchmarkFinalValue: string;
  benchmarkTotalGain: string;
  benchmarkTotalGainPercent: string | null;
  /** `portfolioTotalGain - benchmarkTotalGain` (positive means portfolio beat benchmark). */
  excessGain: string;
  benchmarkOutperformed: boolean;
}

/**
 * Simulates investing every portfolio deposit and withdrawal into a benchmark
 * index on the exact same historical dates (with up to 10-day prior trading day
 * lookup on holidays/weekends).
 *
 * Formula in words:
 *   - Deposit `D > 0` on date `t`: buy `D / benchmarkPrice(t)` benchmark units.
 *   - Withdrawal `W > 0` on date `t`: sell `min(heldUnits, W / benchmarkPrice(t))`;
 *     if `heldUnits` runs out (benchmark performed worse than your holdings),
 *     track the uncovered excess withdrawal as negative cash reserve `cashBuffer`
 *     so total profit (`finalNetEquity + totalWithdrawn - totalDeposited`) stays
 *     mathematically apples-to-apples with your actual portfolio profit.
 */
export function computeSameCashFlowsSimulation(params: {
  benchmarkSymbol: string;
  portfolioSeries: readonly { date: string; portfolioValue: DecimalInput }[];
  externalCashFlows: readonly ExternalCashFlowEvent[];
  benchmarkPricesByDate: ReadonlyMap<string, DecimalInput>;
}): SameCashFlowsSimulationResult | null {
  const sortedDates = [...params.benchmarkPricesByDate.keys()].sort();
  if (sortedDates.length === 0 || params.portfolioSeries.length === 0) {
    return null;
  }

  const sortedPortfolio = [...params.portfolioSeries].sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  // Aggregate cash flows by calendar date.
  const depositsByDate = new Map<string, DecimalValue>();
  const withdrawalsByDate = new Map<string, DecimalValue>();
  let totalDeposited = ZERO;
  let totalWithdrawn = ZERO;

  for (const ev of params.externalCashFlows) {
    const flow = toDecimal(ev.netFlow);
    if (flow.gt(QUANTITY_EPSILON)) {
      totalDeposited = totalDeposited.plus(flow);
      depositsByDate.set(
        ev.date,
        (depositsByDate.get(ev.date) ?? ZERO).plus(flow),
      );
    } else if (flow.lt(QUANTITY_EPSILON.negated())) {
      const withdrawal = flow.negated();
      totalWithdrawn = totalWithdrawn.plus(withdrawal);
      withdrawalsByDate.set(
        ev.date,
        (withdrawalsByDate.get(ev.date) ?? ZERO).plus(withdrawal),
      );
    }
  }

  // Build ordered timeline merging cash-flow event dates and portfolio valuation dates.
  const allEventDates = new Set<string>([
    ...depositsByDate.keys(),
    ...withdrawalsByDate.keys(),
    ...sortedPortfolio.map((p) => p.date),
  ]);
  const orderedDates = [...allEventDates].sort();

  const portfolioValueByDate = new Map<string, DecimalValue>();
  for (const pt of sortedPortfolio) {
    portfolioValueByDate.set(pt.date, toDecimal(pt.portfolioValue));
  }

  function findBenchmarkPrice(targetDate: string): DecimalValue | null {
    const exact = params.benchmarkPricesByDate.get(targetDate);
    if (exact !== undefined && toDecimal(exact).gt(ZERO)) {
      return toDecimal(exact);
    }
    // Step back to latest available trading close on or before `targetDate`.
    let candidate: DecimalValue | null = null;
    for (let i = sortedDates.length - 1; i >= 0; i -= 1) {
      if (sortedDates[i] <= targetDate) {
        const val = toDecimal(params.benchmarkPricesByDate.get(sortedDates[i])!);
        if (val.gt(ZERO)) {
          candidate = val;
          break;
        }
      }
    }
    if (candidate !== null) {
      return candidate;
    }
    // If cash flow predates first available benchmark bar by a few days, use first bar.
    const firstVal = toDecimal(params.benchmarkPricesByDate.get(sortedDates[0])!);
    return firstVal.gt(ZERO) ? firstVal : null;
  }

  let benchmarkUnits = ZERO;
  let cashBuffer = ZERO;
  let cumulativeNetContributed = ZERO;
  let lastKnownPortfolioVal = ZERO;

  const dailySeries: SameCashFlowsPoint[] = [];

  for (const date of orderedDates) {
    const dep = depositsByDate.get(date) ?? ZERO;
    const wd = withdrawalsByDate.get(date) ?? ZERO;
    const benchPrice = findBenchmarkPrice(date);

    if (benchPrice !== null && benchPrice.gt(ZERO)) {
      if (dep.gt(ZERO)) {
        // Apply cashBuffer debt first before buying units, or deposit directly if >= 0.
        if (cashBuffer.lt(ZERO)) {
          const offset = DecimalMin(dep, cashBuffer.negated());
          cashBuffer = cashBuffer.plus(offset);
          const remainingDep = dep.minus(offset);
          if (remainingDep.gt(ZERO)) {
            benchmarkUnits = benchmarkUnits.plus(remainingDep.div(benchPrice));
          }
        } else {
          benchmarkUnits = benchmarkUnits.plus(dep.div(benchPrice));
        }
      }

      if (wd.gt(ZERO)) {
        const currentValue = benchmarkUnits.mul(benchPrice);
        if (currentValue.gte(wd)) {
          benchmarkUnits = benchmarkUnits.minus(wd.div(benchPrice));
        } else {
          // Benchmark equity exhausted by withdrawals matching actual portfolio outflows.
          const shortfall = wd.minus(currentValue);
          benchmarkUnits = ZERO;
          cashBuffer = cashBuffer.minus(shortfall);
        }
      }
    }

    cumulativeNetContributed = cumulativeNetContributed.plus(dep).minus(wd);

    const pVal = portfolioValueByDate.get(date);
    if (pVal !== undefined) {
      lastKnownPortfolioVal = pVal;
    }

    if (portfolioValueByDate.has(date) && benchPrice !== null) {
      const benchEquity = benchmarkUnits.mul(benchPrice).plus(cashBuffer);
      dailySeries.push({
        date,
        portfolioValue: toDecimalString(lastKnownPortfolioVal, 2),
        benchmarkValue: toDecimalString(benchEquity, 2),
        netContributed: toDecimalString(cumulativeNetContributed, 2),
      });
    }
  }

  if (dailySeries.length === 0) {
    return null;
  }

  const lastPoint = dailySeries[dailySeries.length - 1];
  const portfolioFinalValue = toDecimal(lastPoint.portfolioValue);
  const benchmarkFinalValue = toDecimal(lastPoint.benchmarkValue);
  const netContributed = totalDeposited.minus(totalWithdrawn);

  const portfolioTotalGain = portfolioFinalValue
    .plus(totalWithdrawn)
    .minus(totalDeposited);
  const benchmarkTotalGain = benchmarkFinalValue
    .plus(totalWithdrawn)
    .minus(totalDeposited);

  const portfolioTotalGainPercent = totalDeposited.gt(ZERO)
    ? safeDivide(portfolioTotalGain.mul(HUNDRED), totalDeposited)?.toDecimalPlaces(2) ??
      null
    : null;
  const benchmarkTotalGainPercent = totalDeposited.gt(ZERO)
    ? safeDivide(benchmarkTotalGain.mul(HUNDRED), totalDeposited)?.toDecimalPlaces(2) ??
      null
    : null;

  const excessGain = portfolioTotalGain.minus(benchmarkTotalGain);

  return {
    benchmarkSymbol: params.benchmarkSymbol,
    dailySeries,
    totalDeposited: toDecimalString(totalDeposited, 2),
    totalWithdrawn: toDecimalString(totalWithdrawn, 2),
    netContributed: toDecimalString(netContributed, 2),
    portfolioFinalValue: toDecimalString(portfolioFinalValue, 2),
    portfolioTotalGain: toDecimalString(portfolioTotalGain, 2),
    portfolioTotalGainPercent: portfolioTotalGainPercent
      ? toDecimalString(portfolioTotalGainPercent, 2)
      : null,
    benchmarkFinalValue: toDecimalString(benchmarkFinalValue, 2),
    benchmarkTotalGain: toDecimalString(benchmarkTotalGain, 2),
    benchmarkTotalGainPercent: benchmarkTotalGainPercent
      ? toDecimalString(benchmarkTotalGainPercent, 2)
      : null,
    excessGain: toDecimalString(excessGain, 2),
    benchmarkOutperformed: excessGain.gt(ZERO),
  };
}

function DecimalMin(a: DecimalValue, b: DecimalValue): DecimalValue {
  return a.lte(b) ? a : b;
}

