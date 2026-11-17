"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ColorType,
  createChart,
  CrosshairMode,
  type IChartApi,
  LineSeries,
  LineStyle,
} from "lightweight-charts";
import { GainBadge } from "@/components/ui/gain-badge";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  type AnalyticsChartRange,
  filterPointsByAnalyticsRange,
  SERIES_PALETTE,
  useChartThemePalette,
} from "@/lib/charts/theme";
import { formatMoney, formatPercent } from "@/lib/format";
import type { SameCashFlowsSimulationResult } from "@/lib/finance/risk-metrics";
import type { BenchmarkSeriesData } from "@/lib/services/analytics";

interface BenchmarkComparisonChartProps {
  currency: "SGD" | "USD";
  selectedBenchmarks: readonly BenchmarkSeriesData[];
  primaryBenchmark: BenchmarkSeriesData | null;
  range?: AnalyticsChartRange;
  onRangeChange?: (nextRange: AnalyticsChartRange) => void;
  hideRangeSelector?: boolean;
}

export const BENCH_RANGE_OPTIONS: readonly AnalyticsChartRange[] = [
  "3M",
  "6M",
  "YTD",
  "1Y",
  "3Y",
  "5Y",
  "MAX",
];

interface HoveredReadout {
  date: string;
  values: Record<string, number>;
}

interface SimulatedFundSeries {
  symbol: string;
  displaySymbol: string;
  name: string;
  label: string;
  color: string;
  isFocus: boolean;
  summary: SameCashFlowsSimulationResult;
  series: ReturnType<typeof filterPointsByAnalyticsRange<SameCashFlowsSimulationResult["dailySeries"][number]>>;
}

function formatCrosshairTime(time: unknown): string | null {
  if (!time) {
    return null;
  }
  if (typeof time === "string") {
    return time;
  }
  if (typeof time === "object" && "year" in time && "month" in time && "day" in time) {
    const bd = time as { year: number; month: number; day: number };
    return `${String(bd.year).padStart(4, "0")}-${String(bd.month).padStart(2, "0")}-${String(bd.day).padStart(2, "0")}`;
  }
  if (typeof time === "number" && Number.isFinite(time)) {
    return new Date(time * 1000).toISOString().slice(0, 10);
  }
  return String(time);
}

/**
 * Interactive "Same cash flows" chart comparing actual portfolio market value
 * against investing the exact same cash flows into every toggled benchmark fund,
 * with simulated sells capped so no simulated position ever goes negative.
 */
export function BenchmarkComparisonChart({
  currency,
  selectedBenchmarks,
  primaryBenchmark,
  range: controlledRange,
  onRangeChange,
  hideRangeSelector = false,
}: BenchmarkComparisonChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { palette, themeTick } = useChartThemePalette();
  const [internalRange, setInternalRange] = useState<AnalyticsChartRange>("MAX");
  const range = controlledRange ?? internalRange;
  const setRange = onRangeChange ?? setInternalRange;
  const [hovered, setHovered] = useState<HoveredReadout | null>(null);

  const simulationModel = useMemo(() => {
    const activeFunds: SimulatedFundSeries[] = [];

    selectedBenchmarks.forEach((bench, idx) => {
      if (bench.status !== "ok" || !bench.sameCashFlows) {
        return;
      }
      const filtered = filterPointsByAnalyticsRange(
        bench.sameCashFlows.dailySeries,
        range,
      );
      if (filtered.length === 0) {
        return;
      }
      const color = SERIES_PALETTE[(idx + 1) % (SERIES_PALETTE.length - 1)];
      activeFunds.push({
        symbol: bench.symbol,
        displaySymbol: bench.displaySymbol,
        name: bench.name,
        label: `${bench.name} (${bench.displaySymbol})`,
        color,
        isFocus: primaryBenchmark?.symbol === bench.symbol,
        summary: bench.sameCashFlows,
        series: filtered,
      });
    });

    if (activeFunds.length === 0) {
      return null;
    }

    // Use the focus fund (or longest simulated span) as the baseline portfolio & net-contributed curve.
    const baseline =
      activeFunds.find((f) => f.isFocus) ??
      activeFunds.reduce((best, cur) =>
        cur.series.length > best.series.length ? cur : best,
      );

    return {
      funds: activeFunds,
      focusFund: activeFunds.find((f) => f.isFocus) ?? activeFunds[0],
      baselineSummary: baseline.summary,
      baselineSeries: baseline.series,
    };
  }, [selectedBenchmarks, primaryBenchmark, range]);

  useEffect(() => {
    const el = containerRef.current;
    if (
      !el ||
      !simulationModel ||
      simulationModel.baselineSeries.length === 0
    ) {
      return;
    }

    const chart: IChartApi = createChart(el, {
      width: el.clientWidth,
      height: 310,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: palette.ink2,
        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: palette.grid },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.1, bottom: 0.08 },
      },
      timeScale: {
        borderVisible: false,
        rightOffset: 3,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: palette.ink3,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: palette.surface2,
        },
        horzLine: {
          color: palette.ink3,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: palette.surface2,
        },
      },
      handleScroll: false,
      handleScale: false,
    });

    const valueLookupBySeriesKey = new Map<string, Map<string, number>>();

    const pSeries = chart.addSeries(LineSeries, {
      color: palette.accent,
      lineWidth: 3,
      priceLineVisible: false,
      lastValueVisible: true,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    pSeries.setData(
      simulationModel.baselineSeries.map((p) => ({
        time: p.date,
        value: Number(p.portfolioValue),
      })),
    );
    valueLookupBySeriesKey.set(
      "portfolio",
      new Map(
        simulationModel.baselineSeries.map((p) => [
          p.date,
          Number(p.portfolioValue),
        ]),
      ),
    );

    for (const fund of simulationModel.funds) {
      const bSeries = chart.addSeries(LineSeries, {
        color: fund.color,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      });
      bSeries.setData(
        fund.series.map((p) => ({
          time: p.date,
          value: Number(p.benchmarkValue),
        })),
      );
      valueLookupBySeriesKey.set(
        `bench:${fund.symbol}`,
        new Map(fund.series.map((p) => [p.date, Number(p.benchmarkValue)])),
      );
    }

    const cSeries = chart.addSeries(LineSeries, {
      color: palette.ink3,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    cSeries.setData(
      simulationModel.baselineSeries.map((p) => ({
        time: p.date,
        value: Number(p.netContributed),
      })),
    );
    valueLookupBySeriesKey.set(
      "netContributed",
      new Map(
        simulationModel.baselineSeries.map((p) => [
          p.date,
          Number(p.netContributed),
        ]),
      ),
    );

    chart.timeScale().fitContent();

    chart.subscribeCrosshairMove((param) => {
      const dateStr = formatCrosshairTime(param.time);
      if (!dateStr) {
        setHovered(null);
        return;
      }
      const vals: Record<string, number> = {};
      for (const [key, lookup] of valueLookupBySeriesKey.entries()) {
        const matched = lookup.get(dateStr);
        if (matched !== undefined && Number.isFinite(matched)) {
          vals[key] = matched;
        }
      }
      if (Object.keys(vals).length > 0) {
        setHovered({ date: dateStr, values: vals });
      }
    });

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry && entry.contentRect.width > 0) {
        chart.applyOptions({ width: Math.floor(entry.contentRect.width) });
      }
    });
    resizeObserver.observe(el);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      setHovered(null);
    };
  }, [simulationModel, palette, themeTick]);

  const noData =
    !simulationModel || simulationModel.baselineSeries.length === 0;
  const firstDate = simulationModel?.baselineSeries[0]?.date ?? null;
  const latestDate =
    simulationModel?.baselineSeries[simulationModel.baselineSeries.length - 1]
      ?.date ?? null;
  const cappedSymbols =
    simulationModel?.funds
      .filter((f) => f.summary.benchmarkWasCapped)
      .map((f) => f.displaySymbol) ?? [];

  return (
    <div className="space-y-3.5">
      <div className="space-y-2.5">
        {!hideRangeSelector && (
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <p className="text-[12px] text-ink-2 whitespace-nowrap">
              {hovered ? (
                <>
                  As of <span className="font-mono">{hovered.date}</span>
                </>
              ) : (
                <>
                  {range} period
                  {firstDate && latestDate ? (
                    <>
                      {" · "}
                      <span className="font-mono">
                        {firstDate} → {latestDate}
                      </span>
                    </>
                  ) : latestDate ? (
                    <>
                      {" · latest "}
                      <span className="font-mono">{latestDate}</span>
                    </>
                  ) : (
                    ""
                  )}
                </>
              )}
            </p>

            <SegmentedControl
              ariaLabel="Benchmark chart time range"
              size="sm"
              options={BENCH_RANGE_OPTIONS.map((opt) => ({
                value: opt,
                label: opt,
              }))}
              value={range}
              onChange={setRange}
              layoutId="benchmark-range-seg"
            />
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 rounded-[10px] border border-line bg-surface-2 px-3.5 py-2 text-[12.5px]">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            {simulationModel && (
              <>
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: palette.accent }}
                  />
                  <span className="font-medium text-ink">Your Portfolio</span>
                  <span className="num font-medium text-ink-2">
                    {formatMoney(
                      hovered?.values.portfolio ??
                        simulationModel.baselineSummary.portfolioFinalValue,
                      currency,
                    )}
                  </span>
                </span>

                {simulationModel.funds.map((fund) => (
                  <span
                    key={fund.symbol}
                    className="inline-flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: fund.color }}
                    />
                    <span
                      className="font-medium text-ink"
                      title={`total return, dividends reinvested, ${currency}`}
                    >
                      {fund.displaySymbol}
                    </span>
                    <span className="num text-ink-2">
                      {formatMoney(
                        hovered?.values[`bench:${fund.symbol}`] ??
                          fund.summary.benchmarkFinalValue,
                        currency,
                      )}
                    </span>
                  </span>
                ))}

                <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-ink-3">
                  <span className="h-1.5 w-3 border-t-2 border-dashed border-ink-3" />
                  Net contributed{" "}
                  <span className="num font-medium text-ink-2">
                    {formatMoney(
                      hovered?.values.netContributed ??
                        simulationModel.baselineSummary.netContributed,
                      currency,
                    )}
                  </span>
                </span>
              </>
            )}
          </div>

          {hideRangeSelector && (
            <span className="whitespace-nowrap text-[11.5px] text-ink-3">
              {hovered ? (
                <>
                  As of <span className="font-mono text-ink-2">{hovered.date}</span>
                </>
              ) : (
                <>
                  {range}
                  {firstDate && latestDate ? (
                    <>
                      {" · "}
                      <span className="font-mono">
                        {firstDate} → {latestDate}
                      </span>
                    </>
                  ) : latestDate ? (
                    <>
                      {" · "}
                      <span className="font-mono">{latestDate}</span>
                    </>
                  ) : (
                    ""
                  )}
                </>
              )}
            </span>
          )}
        </div>
      </div>

      {noData ? (
        <div className="flex h-64 items-center justify-center rounded-[12px] border border-dashed border-line bg-surface-2 px-4 text-center text-[13px] text-ink-2">
          Toggle at least one fund above or record portfolio transactions to
          simulate same-cash-flow performance in {currency}.
        </div>
      ) : (
        <div
          ref={containerRef}
          className="w-full"
          aria-label={`Same cash flows comparison chart in ${currency}`}
        />
      )}

      {simulationModel && (
        <div className="space-y-3 rounded-[12px] border border-line bg-surface-2 p-4">
          <div>
            <h3 className="text-[13.5px] font-semibold text-ink">
              Side-by-Side Same Cash Flows ({currency})
            </h3>
            <p className="text-[12px] text-ink-3">
              Every buy and sell mirrored into each toggled fund using
              dividend-adjusted closes (total return, dividends reinvested,{" "}
              {currency}).
            </p>
          </div>

          <div className="overflow-x-auto">
            <table
              className="w-full table-fixed text-left text-[13px]"
              style={{
                minWidth: `${330 + simulationModel.funds.length * 165}px`,
              }}
            >
              <colgroup>
                <col className="w-[175px]" />
                <col className="w-[155px]" />
                {simulationModel.funds.map((fund) => (
                  <col key={fund.symbol} />
                ))}
              </colgroup>
              <thead className="border-b border-line text-[11.5px] font-medium uppercase tracking-[0.04em] text-ink-3">
                <tr>
                  <th className="py-2 pr-4">Metric</th>
                  <th className="bg-accent/6 px-3 py-2 text-right text-ink whitespace-nowrap">
                    Your Portfolio
                  </th>
                  {simulationModel.funds.map((fund) => (
                    <th key={fund.symbol} className="px-3 py-2 text-right text-ink">
                      <span className="inline-flex max-w-full items-center justify-end gap-1.5">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: fund.color }}
                        />
                        <span className="truncate">{fund.name}</span>
                        <span className="shrink-0 font-mono text-[11px] text-ink-3">
                          {fund.displaySymbol}
                        </span>
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                <tr>
                  <td className="py-2.5 pr-4 text-ink-2">Total money put in</td>
                  <td className="num bg-accent/6 px-3 py-2.5 text-right font-medium text-ink">
                    {formatMoney(
                      simulationModel.baselineSummary.totalDeposited,
                      currency,
                    )}
                  </td>
                  {simulationModel.funds.map((fund) => (
                    <td
                      key={fund.symbol}
                      className="num px-3 py-2.5 text-right font-medium text-ink"
                    >
                      {formatMoney(fund.summary.benchmarkDeposited, currency)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="py-2.5 pr-4 text-ink-2">Money taken out</td>
                  <td className="num bg-accent/6 px-3 py-2.5 text-right font-medium text-ink">
                    {formatMoney(
                      simulationModel.baselineSummary.totalWithdrawn,
                      currency,
                    )}
                  </td>
                  {simulationModel.funds.map((fund) => (
                    <td
                      key={fund.symbol}
                      className="num px-3 py-2.5 text-right font-medium text-ink"
                    >
                      {formatMoney(fund.summary.benchmarkWithdrawn, currency)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="py-2.5 pr-4 text-ink-2">Current value</td>
                  <td className="num bg-accent/6 px-3 py-2.5 text-right font-medium text-ink">
                    {formatMoney(
                      simulationModel.baselineSummary.portfolioFinalValue,
                      currency,
                    )}
                  </td>
                  {simulationModel.funds.map((fund) => (
                    <td
                      key={fund.symbol}
                      className="num px-3 py-2.5 text-right font-medium text-ink"
                    >
                      {formatMoney(fund.summary.benchmarkFinalValue, currency)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="py-2.5 pr-4 text-ink-2">Dollar profit</td>
                  <td className="bg-accent/6 px-3 py-2.5 text-right">
                    <GainBadge
                      amount={simulationModel.baselineSummary.portfolioTotalGain}
                      currency={currency}
                      size="sm"
                    />
                  </td>
                  {simulationModel.funds.map((fund) => (
                    <td key={fund.symbol} className="px-3 py-2.5 text-right">
                      <GainBadge
                        amount={fund.summary.benchmarkTotalGain}
                        currency={currency}
                        size="sm"
                      />
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="py-2.5 pr-4 text-ink-2">XIRR (annualized)</td>
                  <td className="num bg-accent/6 px-3 py-2.5 text-right font-semibold text-ink">
                    {simulationModel.baselineSummary.portfolioXirrPercent !== null
                      ? formatPercent(
                          simulationModel.baselineSummary.portfolioXirrPercent,
                          { signed: true },
                        )
                      : "—"}
                  </td>
                  {simulationModel.funds.map((fund) => (
                    <td
                      key={fund.symbol}
                      className="num px-3 py-2.5 text-right font-semibold text-ink"
                    >
                      {fund.summary.benchmarkXirrPercent !== null
                        ? formatPercent(fund.summary.benchmarkXirrPercent, {
                            signed: true,
                          })
                        : "—"}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="py-2.5 pr-4 text-ink-2">You vs fund</td>
                  <td className="bg-accent/6 px-3 py-2.5 text-right text-[11.5px] font-medium text-accent">
                    Baseline
                  </td>
                  {simulationModel.funds.map((fund) => (
                    <td key={fund.symbol} className="px-3 py-2.5 text-right">
                      <GainBadge
                        amount={fund.summary.excessGain}
                        currency={currency}
                        size="sm"
                      />
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>

          {cappedSymbols.length > 0 && (
            <p className="text-[11.5px] text-ink-3">
              Note: Simulated sells in{" "}
              <span className="font-mono">{cappedSymbols.join(", ")}</span>{" "}
              exceeded available fund holdings on one or more sell dates and
              were capped so the simulated position never went negative.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
