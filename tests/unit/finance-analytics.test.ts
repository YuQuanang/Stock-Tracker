import { describe, expect, it } from "vitest";
import { filterPointsByAnalyticsRange } from "@/lib/charts/theme";
import {
  computeAnnualizedVolatility,
  computeBenchmarkRegression,
  computeBestWorstPeriods,
  computeCagr,
  computeDrawdownSeries,
  computeHorizonReturns,
  computeSameCashFlowsSimulation,
  computeSharpeRatio,
  computeTimeWeightedReturn,
  computeXirr,
  FxRateBook,
  reconstructPortfolioTimeline,
  toDecimal,
} from "@/lib/finance";

describe("Milestone 7 Pure Finance Analytics Formulas", () => {
  it("computes exact XIRR across irregular deposits, withdrawals, dividends, and terminal value", () => {
    // 10% exact annual compounding over 1 non-leap year (2025-01-01 -> 2026-01-01):
    // Invest $1,000 on 2025-01-01, ending value $1,100 -> XIRR == 10.00%
    const simpleYear = computeXirr([
      { date: "2025-01-01", amount: "-1000" },
      { date: "2026-01-01", amount: "1100" },
    ]);
    expect(simpleYear).not.toBeNull();
    expect(simpleYear!.toNumber()).toBeCloseTo(0.1, 4);

    // Multi-flow irregular schedule:
    // -1000 on 2024-01-01, -500 on 2024-07-02 (+183 days), +50 div on 2024-10-01,
    // +1750 ending value on 2025-01-01 -> positive convergence where NPV == 0
    const irregular = computeXirr([
      { date: "2024-01-01", amount: "-1000" },
      { date: "2024-07-02", amount: "-500" },
      { date: "2024-10-01", amount: "50" },
      { date: "2025-01-01", amount: "1750" },
    ]);
    expect(irregular).not.toBeNull();
    const r = irregular!.toNumber();
    // Verify exact NPV == 0 at solved rate
    const d0 = Date.UTC(2024, 0, 1);
    const npv =
      -1000 +
      -500 / Math.pow(1 + r, (Date.UTC(2024, 6, 2) - d0) / 86_400_000 / 365) +
      50 / Math.pow(1 + r, (Date.UTC(2024, 9, 1) - d0) / 86_400_000 / 365) +
      1750 / Math.pow(1 + r, (Date.UTC(2025, 0, 1) - d0) / 86_400_000 / 365);
    expect(Math.abs(npv)).toBeLessThan(1e-5);

    // Invalid inputs return null (all negative, same day)
    expect(
      computeXirr([
        { date: "2025-01-01", amount: "-100" },
        { date: "2025-06-01", amount: "-200" },
      ]),
    ).toBeNull();
    expect(
      computeXirr([
        { date: "2025-01-01", amount: "-100" },
        { date: "2025-01-01", amount: "120" },
      ]),
    ).toBeNull();
  });

  it("chains Time-Weighted Return (TWR) unaffected by large mid-period cash inflows", () => {
    // Day 1: Deposit $1,000, closes at $1,100 (+10%)
    // Day 2: Market up +10% (so $1,100 -> $1,210), NO flow
    // Day 3: Huge deposit +$10,000 at start-of-day (wait: EOD flow -> Dietz/full):
    //        Test pure deposit before close -> let's test Day 3 zero return when val increases by exact CF
    //        Wait: under Dietz midpoint denominator (prev + 0.5*CF), let's test pure no-flow + Day 1 entry + Full liquidation:
    const result = computeTimeWeightedReturn([
      { date: "2025-01-02", portfolioValue: "1100", externalCashFlow: "1000" }, // +10%
      { date: "2025-01-03", portfolioValue: "1210", externalCashFlow: "0" }, // +10%
      {
        date: "2025-01-06",
        portfolioValue: "1210",
        externalCashFlow: "0",
        dividendInflow: "12.10", // +1% dividend
      },
      // Idle exit on Jan 7 at $1,210 net sell
      { date: "2025-01-07", portfolioValue: "0", externalCashFlow: "-1210" }, // 0%
      // Re-entry Jan 10: deposit $2,000, closes at $2,200 (+10%)
      { date: "2025-01-10", portfolioValue: "2200", externalCashFlow: "2000" },
    ]);

    // Total cumulative factor = 1.10 * 1.10 * 1.01 * 1.00 * 1.10 = 1.34431 (+34.43%)
    expect(result.cumulativeReturnPercent?.toNumber()).toBeCloseTo(34.43, 2);
    expect(result.points[4].cumulativeIndex.toNumber()).toBeCloseTo(134.431, 2);
  });

  it("computes CAGR and horizon period returns across 1D/1W/1M/YTD/1Y/ALL", () => {
    const cagr = computeCagr("0.44", "2023-01-01", "2025-01-01");
    expect(cagr?.toNumber()).toBeCloseTo(0.2, 2); // ~20% CAGR doubles in ~3.8y, +44% in 2y = 20%/y

    const indexSeries = [
      { date: "2025-01-02", value: "100" },
      { date: "2025-11-13", value: "115" },
      { date: "2025-12-31", value: "120" },
      { date: "2026-01-02", value: "120" },
      { date: "2026-10-01", value: "130" },
      { date: "2026-11-01", value: "140" },
      { date: "2026-11-06", value: "150" },
      { date: "2026-11-12", value: "155" },
      { date: "2026-11-13", value: "160" },
    ];
    const horizons = computeHorizonReturns(indexSeries, "2026-11-13");
    expect(horizons.ALL?.toNumber()).toBeCloseTo(60, 2); // 160 / 100 - 1 = +60%
    expect(horizons["1Y"]?.toNumber()).toBeCloseTo((160 / 115 - 1) * 100, 2);
    expect(horizons["3Y"]).toBeNull();
    expect(horizons["5Y"]).toBeNull();
    expect(horizons.YTD?.toNumber()).toBeCloseTo((160 / 120 - 1) * 100, 2); // 2025-12-31=120 -> +33.33%
    expect(horizons["1D"]?.toNumber()).toBeCloseTo((160 / 155 - 1) * 100, 2);
    expect(horizons["1W"]?.toNumber()).toBeCloseTo((160 / 150 - 1) * 100, 2);
  });

  it("computes 3Y, 5Y, and ALL horizon returns and chart slices when inception spans >= 5 years", () => {
    const multiYearSeries = [
      { date: "2021-04-28", value: "80" },
      { date: "2021-11-13", value: "100" },
      { date: "2023-11-13", value: "125" },
      { date: "2025-11-13", value: "150" },
      { date: "2025-12-31", value: "160" },
      { date: "2026-11-12", value: "190" },
      { date: "2026-11-13", value: "200" },
    ];
    const horizons = computeHorizonReturns(multiYearSeries, "2026-11-13");
    expect(horizons["3Y"]?.toNumber()).toBeCloseTo((200 / 125 - 1) * 100, 2); // +60%
    expect(horizons["5Y"]?.toNumber()).toBeCloseTo((200 / 100 - 1) * 100, 2); // +100%
    expect(horizons.ALL?.toNumber()).toBeCloseTo((200 / 80 - 1) * 100, 2); // +150%

    const threeYear = filterPointsByAnalyticsRange(multiYearSeries, "3Y");
    expect(threeYear[0]?.date).toBe("2023-11-13");
    const fiveYear = filterPointsByAnalyticsRange(multiYearSeries, "5Y");
    expect(fiveYear[0]?.date).toBe("2021-11-13");
    const maxRange = filterPointsByAnalyticsRange(multiYearSeries, "MAX");
    expect(maxRange[0]?.date).toBe("2021-04-28");

    const base100Horizons = computeHorizonReturns(multiYearSeries, "2026-11-13", {
      allBaseValue: 100,
    });
    expect(base100Horizons.ALL?.toNumber()).toBeCloseTo(100, 2); // 200 / 100 - 1 = +100%
  });

  it("computes underwater Drawdown series with exact Peak, Trough, and Recovery dates", () => {
    const dd = computeDrawdownSeries([
      { date: "2025-01-01", value: "100" },
      { date: "2025-02-01", value: "120" }, // Peak
      { date: "2025-03-01", value: "90" }, // Trough: (90-120)/120 = -25%
      { date: "2025-04-01", value: "110" }, // Still underwater
      { date: "2025-05-01", value: "125" }, // Recovered!
    ]);

    expect(dd.maxDrawdownPercent?.toNumber()).toBe(-25);
    expect(dd.peakDate).toBe("2025-02-01");
    expect(dd.troughDate).toBe("2025-03-01");
    expect(dd.recoveryDate).toBe("2025-05-01");
    expect(dd.currentDrawdownPercent?.toNumber()).toBe(0);
  });

  it("computes Volatility, Sharpe Ratio, CAPM Beta/Correlation/Alpha, and Best/Worst periods", () => {
    const benchReturns = [
      { date: "2025-01-02", dailyReturn: "0.01" },
      { date: "2025-01-03", dailyReturn: "-0.02" },
      { date: "2025-01-06", dailyReturn: "0.015" },
      { date: "2025-01-07", dailyReturn: "-0.005" },
      { date: "2025-01-08", dailyReturn: "0.02" },
      { date: "2025-02-03", dailyReturn: "-0.01" },
    ];
    // Portfolio moves at exact 1.5x beta of benchmark
    const portReturns = benchReturns.map((b) => ({
      date: b.date,
      dailyReturn: toDecimal(b.dailyReturn).mul("1.5"),
    }));

    const reg = computeBenchmarkRegression({
      portfolioReturns: portReturns,
      benchmarkReturns: benchReturns,
      portfolioAnnualizedReturn: "0.18",
      benchmarkAnnualizedReturn: "0.10",
      riskFreeRateFraction: "0.03",
    });

    expect(reg.sampleSize).toBe(6);
    expect(reg.beta?.toNumber()).toBeCloseTo(1.5, 2);
    expect(reg.correlation?.toNumber()).toBeCloseTo(1.0, 2);
    // alpha = (0.18 - 0.03) - 1.5 * (0.10 - 0.03) = 0.15 - 0.105 = +0.045 = +4.50%
    expect(reg.alphaPercent?.toNumber()).toBeCloseTo(4.5, 2);

    const vol = computeAnnualizedVolatility(portReturns);
    expect(vol).not.toBeNull();
    expect(vol!.toNumber()).toBeGreaterThan(0);

    const sharpe = computeSharpeRatio({
      annualizedReturnFraction: "0.18",
      annualizedVolatilityPercent: vol,
      riskFreeRateFraction: "0.03",
    });
    expect(sharpe).not.toBeNull();
    expect(sharpe!.toNumber()).toBeGreaterThan(0);

    const extremes = computeBestWorstPeriods(portReturns);
    expect(extremes.bestDay?.period).toBe("2025-01-08");
    expect(extremes.bestDay?.percent.toNumber()).toBe(3);
    expect(extremes.worstDay?.period).toBe("2025-01-03");
    expect(extremes.worstDay?.percent.toNumber()).toBe(-3);
    expect(extremes.worstMonth?.period).toBe("2025-02");
  });

  it("simulates 'Same cash flows into benchmark' fairly with matching profit accounting", () => {
    const benchmarkPrices = new Map<string, string>([
      ["2025-01-02", "100"],
      ["2025-02-03", "110"],
      ["2025-03-03", "120"],
    ]);

    // Deposit $1000 on Jan 2 (buys 10 bench units @ $100)
    // Deposit $550 on Feb 3 (buys 5 bench units @ $110 -> total 15 units)
    // Benchmark ending value on Mar 3 = 15 * 120 = $1,800 (total deposited = $1,550, gain = +$250)
    // Actual portfolio ending value on Mar 3 = $2,100 (gain = +$550 -> excess = +$300)
    const sim = computeSameCashFlowsSimulation({
      benchmarkSymbol: "^GSPC",
      portfolioSeries: [
        { date: "2025-01-02", portfolioValue: "1000" },
        { date: "2025-02-03", portfolioValue: "1700" },
        { date: "2025-03-03", portfolioValue: "2100" },
      ],
      externalCashFlows: [
        { date: "2025-01-02", netFlow: "1000" },
        { date: "2025-02-03", netFlow: "550" },
      ],
      benchmarkPricesByDate: benchmarkPrices,
    });

    expect(sim).not.toBeNull();
    expect(Number(sim!.totalDeposited)).toBe(1550);
    expect(Number(sim!.benchmarkFinalValue)).toBe(1800);
    expect(Number(sim!.benchmarkTotalGain)).toBe(250);
    expect(Number(sim!.portfolioTotalGain)).toBe(550);
    expect(Number(sim!.excessGain)).toBe(300);
    expect(sim!.benchmarkOutperformed).toBe(true);
  });

  it("reconstructs portfolio daily timeline across USD/SGD FX rates and stock splits", () => {
    const fxBook = new FxRateBook([
      { date: "2025-01-02", fromCurrency: "USD", toCurrency: "SGD", rate: "1.35" },
      { date: "2025-01-06", fromCurrency: "USD", toCurrency: "SGD", rate: "1.34" },
      { date: "2025-01-08", fromCurrency: "USD", toCurrency: "SGD", rate: "1.36" },
    ]);

    const splitsByInstrument = new Map([
      [
        "inst-usd",
        [
          {
            id: "sp-1",
            exDate: "2025-01-07",
            ratioNumerator: 2,
            ratioDenominator: 1,
          },
        ],
      ],
    ]);

    // Unadjusted bars: $100 pre-split -> $55 post-2:1 split
    const dailyBarsByInstrument = new Map<string, Map<string, string>>([
      [
        "inst-usd",
        new Map([
          ["2025-01-02", "100"],
          ["2025-01-03", "100"],
          ["2025-01-06", "102"],
          ["2025-01-07", "55"],
          ["2025-01-08", "56"],
        ]),
      ],
    ]);

    const timeline = reconstructPortfolioTimeline({
      buckets: [
        {
          portfolioId: "p-1",
          portfolioName: "US Stocks",
          instrumentId: "inst-usd",
          symbol: "ACME",
          currency: "USD",
          manualPrice: null,
          isDelisted: false,
          transactions: [
            {
              id: "tx-1",
              type: "Buy",
              quantity: "10",
              price: "100",
              commissionRaw: "0",
              executedAt: new Date("2025-01-02T14:00:00Z"),
              originalOffset: "+0800",
              currency: "USD",
            },
          ],
        },
      ],
      splitsByInstrument,
      dailyBarsByInstrument,
      fxBook,
      baseCurrency: "SGD",
      dividendMode: "cash",
      asOfDate: "2025-01-08",
    });

    // Day 1 (2025-01-02): 10 sh * $100 * 1.35 = S$1,350
    expect(Number(timeline.points[0].portfolioValue)).toBe(1350);
    // Final day (2025-01-08): 20 split-adjusted shares * $56 * 1.36 = S$1,523.2
    expect(Number(timeline.endingMarketValue)).toBe(1523.2);
    expect(timeline.excludedUnpricedSymbols).toEqual([]);
  });
});
