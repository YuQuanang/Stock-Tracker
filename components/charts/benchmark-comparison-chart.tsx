"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ColorType,
  createChart,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
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
import { formatMoney } from "@/lib/format";
import type { BenchmarkSeriesData } from "@/lib/services/analytics";

export type BenchmarkChartViewMode = "rebased" | "same-cash-flows";

interface BenchmarkComparisonChartProps {
  mode: BenchmarkChartViewMode;
  currency: "SGD" | "USD";
  portfolioSeries: readonly { date: string; twrIndex: string | null }[];
  selectedBenchmarks: readonly BenchmarkSeriesData[];
  primaryBenchmark: BenchmarkSeriesData | null;
}

const BENCH_RANGE_OPTIONS: readonly AnalyticsChartRange[] = [
  "3M",
  "6M",
  "YTD",
  "1Y",
  "5Y",
  "MAX",
];

interface HoveredReadout {
  date: string;
  values: Record<string, number>;
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

function rebaseWindowTo100(
  points: readonly { date: string; value: number }[],
): { date: string; value: number }[] {
  if (points.length === 0) return [];
  const firstVal = points[0].value;
  if (!(firstVal > 0)) return [];
  return points.map((p) => ({
    date: p.date,
    value: Number(((p.value / firstVal) * 100).toFixed(4)),
  }));
}

/**
 * Dual-mode Benchmark Comparison Chart built on Lightweight Charts v5:
 *  - **"Rebased to 100"**: multi-line TWR vs benchmarks starting cleanly at 100
 *  - **"Same cash flows"**: actual portfolio value vs hypothetical benchmark equity
 *    generated from identical cash contributions and withdrawals
 */
export function BenchmarkComparisonChart({
  mode,
  currency,
  portfolioSeries,
  selectedBenchmarks,
  primaryBenchmark,
}: BenchmarkComparisonChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { palette, themeTick } = useChartThemePalette();
  const [range, setRange] = useState<AnalyticsChartRange>("MAX");
  const [hovered, setHovered] = useState<HoveredReadout | null>(null);

  const rebasedLines = useMemo(() => {
    if (mode !== "rebased") {
      return [];
    }

    const activePortfolio = portfolioSeries
      .filter((p) => p.twrIndex !== null && Number(p.twrIndex) > 0)
      .map((p) => ({ date: p.date, value: Number(p.twrIndex!) }));

    const slicedPortfolio = rebaseWindowTo100(
      filterPointsByAnalyticsRange(activePortfolio, range),
    );

    const startAnchor = slicedPortfolio[0]?.date ?? null;

    const lines: {
      key: string;
      label: string;
      color: string;
      isPortfolio: boolean;
      data: { date: string; value: number }[];
    }[] = [];

    if (slicedPortfolio.length >= 2) {
      lines.push({
        key: "__portfolio__",
        label: "Your Portfolio (TWR)",
        color: palette.accent,
        isPortfolio: true,
        data: slicedPortfolio,
      });
    }

    selectedBenchmarks.forEach((bench, idx) => {
      if (bench.status !== "ok" || bench.rebasedSeries.length < 2) {
        return;
      }
      const rawPoints = bench.rebasedSeries
        .map((p) => ({ date: p.date, value: Number(p.value) }))
        .filter((p) => Number.isFinite(p.value) && p.value > 0);

      const filtered = startAnchor
        ? rawPoints.filter((p) => p.date >= startAnchor)
        : filterPointsByAnalyticsRange(rawPoints, range);

      const rebased = rebaseWindowTo100(
        filtered.length >= 2 ? filtered : rawPoints,
      );

      if (rebased.length >= 2) {
        lines.push({
          key: bench.symbol,
          label: `${bench.name} (${bench.displaySymbol})`,
          color: SERIES_PALETTE[(idx + 1) % (SERIES_PALETTE.length - 1)],
          isPortfolio: false,
          data: rebased,
        });
      }
    });

    return lines;
  }, [mode, portfolioSeries, selectedBenchmarks, range, palette.accent]);

  const cashFlowSimulation = useMemo(() => {
    if (mode !== "same-cash-flows" || !primaryBenchmark?.sameCashFlows) {
      return null;
    }
    const filtered = filterPointsByAnalyticsRange(
      primaryBenchmark.sameCashFlows.dailySeries,
      range,
    );
    return {
      summary: primaryBenchmark.sameCashFlows,
      series: filtered,
      benchLabel: `${primaryBenchmark.name} (${primaryBenchmark.displaySymbol})`,
    };
  }, [mode, primaryBenchmark, range]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const hasRebased = mode === "rebased" && rebasedLines.length > 0;
    const hasCashFlow =
      mode === "same-cash-flows" &&
      cashFlowSimulation !== null &&
      cashFlowSimulation.series.length > 0;

    if (!hasRebased && !hasCashFlow) {
      return;
    }

    const chart: IChartApi = createChart(el, {
      width: el.clientWidth,
      height: 310,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: palette.ink3,
        fontFamily:
          'ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif',
        fontSize: 11,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: palette.line },
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
          labelBackgroundColor: palette.ink2,
        },
        horzLine: {
          color: palette.ink3,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: palette.ink2,
        },
      },
      handleScroll: false,
      handleScale: false,
    });

    const valueLookupBySeriesKey = new Map<string, Map<string, number>>();
    const allSeriesHandles: { key: string; series: ISeriesApi<"Line"> }[] = [];

    if (mode === "rebased") {
      for (const line of rebasedLines) {
        const s = chart.addSeries(LineSeries, {
          color: line.color,
          lineWidth: line.isPortfolio ? 3 : 2,
          priceLineVisible: false,
          lastValueVisible: true,
        });
        s.setData(line.data.map((d) => ({ time: d.date, value: d.value })));
        valueLookupBySeriesKey.set(
          line.key,
          new Map(line.data.map((d) => [d.date, d.value])),
        );
        allSeriesHandles.push({ key: line.key, series: s });
      }
    } else if (cashFlowSimulation) {
      const pSeries = chart.addSeries(LineSeries, {
        color: palette.accent,
        lineWidth: 3,
        priceLineVisible: false,
        lastValueVisible: true,
      });
      pSeries.setData(
        cashFlowSimulation.series.map((p) => ({
          time: p.date,
          value: Number(p.portfolioValue),
        })),
      );

      const bSeries = chart.addSeries(LineSeries, {
        color: SERIES_PALETTE[1],
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
      });
      bSeries.setData(
        cashFlowSimulation.series.map((p) => ({
          time: p.date,
          value: Number(p.benchmarkValue),
        })),
      );

      const cSeries = chart.addSeries(LineSeries, {
        color: palette.ink3,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      cSeries.setData(
        cashFlowSimulation.series.map((p) => ({
          time: p.date,
          value: Number(p.netContributed),
        })),
      );

      valueLookupBySeriesKey.set(
        "portfolio",
        new Map(
          cashFlowSimulation.series.map((p) => [
            p.date,
            Number(p.portfolioValue),
          ]),
        ),
      );
      valueLookupBySeriesKey.set(
        "benchmark",
        new Map(
          cashFlowSimulation.series.map((p) => [
            p.date,
            Number(p.benchmarkValue),
          ]),
        ),
      );
      valueLookupBySeriesKey.set(
        "netContributed",
        new Map(
          cashFlowSimulation.series.map((p) => [
            p.date,
            Number(p.netContributed),
          ]),
        ),
      );
      allSeriesHandles.push(
        { key: "portfolio", series: pSeries },
        { key: "benchmark", series: bSeries },
        { key: "netContributed", series: cSeries },
      );
    }

    chart.timeScale().fitContent();

    chart.subscribeCrosshairMove((param) => {
      const dateStr = formatCrosshairTime(param.time);
      if (
        !dateStr ||
        !param.point ||
        param.point.x < 0 ||
        param.point.y < 0
      ) {
        setHovered(null);
        return;
      }
      const values: Record<string, number> = {};
      for (const handle of allSeriesHandles) {
        const direct = valueLookupBySeriesKey.get(handle.key)?.get(dateStr);
        if (direct !== undefined) {
          values[handle.key] = direct;
        } else {
          const dataPoint = param.seriesData.get(handle.series) as
            | { value?: number }
            | undefined;
          if (dataPoint && typeof dataPoint.value === "number") {
            values[handle.key] = dataPoint.value;
          }
        }
      }
      setHovered({ date: dateStr, values });
    });

    let lastObservedWidth = Math.floor(el.clientWidth);
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const nextWidth = Math.floor(entry.contentRect.width);
      if (nextWidth > 0 && nextWidth !== lastObservedWidth) {
        lastObservedWidth = nextWidth;
        chart.applyOptions({ width: nextWidth });
      }
    });
    resizeObserver.observe(el);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      setHovered(null);
    };
  }, [mode, rebasedLines, cashFlowSimulation, palette, themeTick]);

  const noData =
    (mode === "rebased" && rebasedLines.length === 0) ||
    (mode === "same-cash-flows" && !cashFlowSimulation);

  const latestDate =
    mode === "rebased"
      ? (rebasedLines[0]?.data[rebasedLines[0].data.length - 1]?.date ?? null)
      : (cashFlowSimulation?.series[cashFlowSimulation.series.length - 1]
          ?.date ?? null);

  return (
    <div className="space-y-3">
      {/* Toolbar & Legend separated cleanly so scrubbing never shifts controls or chart height */}
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <p className="num text-[12px] text-ink-3 whitespace-nowrap">
            {hovered
              ? `As of ${hovered.date}`
              : `${range} period${latestDate ? ` · latest ${latestDate}` : ""}`}
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

        <div className="min-h-[26px] flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px]">
          {mode === "rebased" &&
            rebasedLines.map((line) => {
              const latestVal = line.data[line.data.length - 1]?.value ?? 100;
              const val = hovered?.values[line.key] ?? latestVal;
              const pctChange = val - 100;
              return (
                <span
                  key={line.key}
                  className="inline-flex items-center gap-1.5 whitespace-nowrap"
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: line.color }}
                  />
                  <span className="font-medium text-ink">{line.label}</span>
                  <span className="num text-ink-2">
                    {val.toFixed(1)} (
                    {pctChange >= 0
                      ? `+${pctChange.toFixed(1)}%`
                      : `${pctChange.toFixed(1)}%`}
                    )
                  </span>
                </span>
              );
            })}

          {mode === "same-cash-flows" && cashFlowSimulation && (
            <>
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: palette.accent }}
                />
                <span className="font-medium text-ink">Your Portfolio</span>
                <span className="num text-ink-2">
                  {formatMoney(
                    hovered?.values.portfolio ??
                      cashFlowSimulation.summary.portfolioFinalValue,
                    currency,
                  )}
                </span>
              </span>
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: SERIES_PALETTE[1] }}
                />
                <span className="font-medium text-ink">
                  {cashFlowSimulation.benchLabel}
                </span>
                <span className="num text-ink-2">
                  {formatMoney(
                    hovered?.values.benchmark ??
                      cashFlowSimulation.summary.benchmarkFinalValue,
                    currency,
                  )}
                </span>
              </span>
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-ink-3">
                <span className="h-1.5 w-3 border-t-2 border-dashed border-ink-3" />
                Net contributed{" "}
                <span className="num font-medium text-ink-2">
                  {formatMoney(
                    hovered?.values.netContributed ??
                      cashFlowSimulation.summary.netContributed,
                    currency,
                  )}
                </span>
              </span>
            </>
          )}
        </div>
      </div>

      {noData ? (
        <div className="flex h-64 items-center justify-center rounded-[14px] border border-dashed border-line bg-surface-2/40 text-center text-[13px] text-ink-3">
          Select at least one benchmark or record portfolio transactions to
          compare historical performance.
        </div>
      ) : (
        <div
          ref={containerRef}
          className="w-full"
          aria-label={`Benchmark comparison chart in ${currency}`}
        />
      )}

      {mode === "same-cash-flows" && cashFlowSimulation && (
        <div className="grid grid-cols-1 gap-3 rounded-[14px] border border-line bg-surface-2/50 p-3.5 sm:grid-cols-3">
          <div>
            <p className="text-[11.5px] font-medium text-ink-3">
              Your total profit
            </p>
            <div className="mt-1">
              <GainBadge
                amount={cashFlowSimulation.summary.portfolioTotalGain}
                currency={currency}
                percent={cashFlowSimulation.summary.portfolioTotalGainPercent}
                size="md"
              />
            </div>
          </div>

          <div>
            <p className="text-[11.5px] font-medium text-ink-3">
              If invested in {primaryBenchmark?.displaySymbol}
            </p>
            <div className="mt-1">
              <GainBadge
                amount={cashFlowSimulation.summary.benchmarkTotalGain}
                currency={currency}
                percent={cashFlowSimulation.summary.benchmarkTotalGainPercent}
                size="md"
              />
            </div>
          </div>

          <div>
            <p className="text-[11.5px] font-medium text-ink-3">
              Relative advantage ({currency})
            </p>
            <div className="mt-1 flex items-center gap-2">
              <GainBadge
                amount={cashFlowSimulation.summary.excessGain}
                currency={currency}
                size="md"
                pill
              />
              <span className="text-[12px] text-ink-2">
                {cashFlowSimulation.summary.benchmarkOutperformed
                  ? "ahead of index"
                  : "behind index"}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

