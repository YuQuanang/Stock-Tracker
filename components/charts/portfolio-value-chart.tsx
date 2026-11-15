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
  ANALYTICS_RANGE_OPTIONS,
  type AnalyticsChartRange,
  filterPointsByAnalyticsRange,
  useChartThemePalette,
} from "@/lib/charts/theme";
import { formatMoney } from "@/lib/format";

export interface PortfolioValuePoint {
  date: string;
  portfolioValue: string;
  openCostBasis: string;
  netCashInvested: string;
  twrIndex: string | null;
}

interface PortfolioValueChartProps {
  points: readonly PortfolioValuePoint[];
  currency: "SGD" | "USD";
  excludedUnpricedSymbols?: readonly string[];
}

interface CrosshairSnapshot {
  date: string;
  marketValue: number;
  costBasis: number;
}

/**
 * Interactive Portfolio Market Value Over Time chart built on TradingView
 * Lightweight Charts v5, paired with an optional FIFO Cost Basis overlay.
 */
export function PortfolioValueChart({
  points,
  currency,
  excludedUnpricedSymbols = [],
}: PortfolioValueChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { palette, themeTick } = useChartThemePalette();
  const [range, setRange] = useState<AnalyticsChartRange>("1Y");
  const [showCostBasis, setShowCostBasis] = useState(true);
  const [hoverPoint, setHoverPoint] = useState<CrosshairSnapshot | null>(null);

  const visiblePoints = useMemo(
    () => filterPointsByAnalyticsRange(points, range),
    [points, range],
  );

  const summaryStats = useMemo(() => {
    if (visiblePoints.length === 0) {
      return null;
    }
    const first = visiblePoints[0];
    const last = visiblePoints[visiblePoints.length - 1];
    const startVal = Number(first.portfolioValue);
    const endVal = Number(last.portfolioValue);
    const costBasis = Number(last.openCostBasis);
    const change = endVal - startVal;
    const changePct = startVal > 0 ? (change / startVal) * 100 : null;
    const unrealized = endVal - costBasis;
    const unrealizedPct = costBasis > 0 ? (unrealized / costBasis) * 100 : null;

    return {
      firstDate: first.date,
      latestDate: last.date,
      endVal,
      costBasis,
      rangeChange: change,
      rangeChangePct: changePct,
      unrealized,
      unrealizedPct,
    };
  }, [visiblePoints]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || visiblePoints.length === 0) {
      return;
    }

    const mvPoints = visiblePoints.map((p) => ({
      time: p.date,
      value: Number(p.portfolioValue),
    }));
    const cbPoints = visiblePoints.map((p) => ({
      time: p.date,
      value: Number(p.openCostBasis),
    }));
    const pointByDate = new Map(
      visiblePoints.map((p) => [
        p.date,
        {
          date: p.date,
          marketValue: Number(p.portfolioValue),
          costBasis: Number(p.openCostBasis),
        },
      ]),
    );

    const chart: IChartApi = createChart(el, {
      width: el.clientWidth,
      height: 290,
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
        scaleMargins: { top: 0.12, bottom: 0.08 },
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

    const lineSeries: ISeriesApi<"Line"> = chart.addSeries(LineSeries, {
      color: palette.accent,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    lineSeries.setData(mvPoints);

    if (showCostBasis) {
      const costSeries: ISeriesApi<"Line"> = chart.addSeries(LineSeries, {
        color: palette.ink3,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      costSeries.setData(cbPoints);
    }

    chart.timeScale().fitContent();

    chart.subscribeCrosshairMove((param) => {
      if (!param.time) {
        setHoverPoint(null);
        return;
      }
      const key = String(param.time);
      const matched = pointByDate.get(key);
      if (matched) {
        setHoverPoint(matched);
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
      setHoverPoint(null);
    };
  }, [visiblePoints, showCostBasis, palette, themeTick]);

  if (points.length === 0 || !summaryStats) {
    return (
      <div className="flex h-64 items-center justify-center rounded-[12px] border border-dashed border-line bg-surface-2 px-4 text-center text-[13px] text-ink-2">
        Historical valuation curve will appear once priced portfolio holdings
        have transaction history.
      </div>
    );
  }

  const displayedVal = hoverPoint
    ? hoverPoint.marketValue
    : summaryStats.endVal;
  const displayedCost = hoverPoint
    ? hoverPoint.costBasis
    : summaryStats.costBasis;
  const displayedUnrealized = displayedVal - displayedCost;
  const displayedUnrealizedPct =
    displayedCost > 0 ? (displayedUnrealized / displayedCost) * 100 : null;

  return (
    <div className="space-y-3">
      {/* Fixed-height header so scrubbing values never shifts card height or controls */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-h-[54px] space-y-0.5">
          <div className="flex flex-wrap items-baseline gap-2.5">
            <span className="num text-[24px] font-semibold tracking-[-0.02em] text-ink">
              {formatMoney(displayedVal, currency)}
            </span>
            <GainBadge
              amount={displayedUnrealized}
              currency={currency}
              percent={displayedUnrealizedPct}
              size="sm"
              pill
            />
          </div>
          <p className="text-[12px] text-ink-2">
            {hoverPoint ? (
              <>
                As of <span className="font-mono">{hoverPoint.date}</span>
              </>
            ) : (
              <>
                {range} period ·{" "}
                <span className="font-mono">
                  {summaryStats.firstDate} → {summaryStats.latestDate}
                </span>
              </>
            )}
            {" · "}
            Open cost basis{" "}
            <span className="num font-medium text-ink">
              {formatMoney(displayedCost, currency)}
            </span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowCostBasis((prev) => !prev)}
            className={`inline-flex h-7 items-center gap-1.5 rounded-[10px] border px-2.5 text-[12px] font-medium transition-colors ${
              showCostBasis
                ? "border-accent/40 bg-accent/12 text-accent"
                : "border-line bg-surface-2 text-ink-2 hover:text-ink"
            }`}
          >
            <span className="h-0.5 w-3 border-t-2 border-dashed border-current" />
            Cost basis
          </button>

          <SegmentedControl
            ariaLabel="Chart time range"
            size="sm"
            options={ANALYTICS_RANGE_OPTIONS.map((opt) => ({
              value: opt,
              label: opt,
            }))}
            value={range}
            onChange={setRange}
            layoutId="portfolio-value-range-seg"
          />
        </div>
      </div>

      <div
        ref={containerRef}
        className="w-full"
        aria-label={`Portfolio market value chart in ${currency}`}
      />

      {excludedUnpricedSymbols.length > 0 && (
        <p className="text-[12px] text-ink-3">
          Excludes unpriced assets without manual prices:{" "}
          <span className="font-mono text-ink-2">
            {excludedUnpricedSymbols.join(", ")}
          </span>
          .
        </p>
      )}
    </div>
  );
}
