"use client";

import { useEffect, useRef, useState } from "react";
import {
  AreaSeries,
  ColorType,
  createChart,
  CrosshairMode,
  type IChartApi,
  LineSeries,
  LineStyle,
} from "lightweight-charts";
import { formatPercent } from "@/lib/format";
import { colorWithAlpha, useChartThemePalette } from "@/lib/charts/theme";

interface DrawdownSeriesPoint {
  date: string;
  drawdownPercent: string;
}

interface DrawdownChartProps {
  portfolioDrawdown: {
    points: DrawdownSeriesPoint[];
    maxDrawdownPercent: string | null;
    peakDate: string | null;
    troughDate: string | null;
    recoveryDate: string | null;
    currentDrawdownPercent: string | null;
  };
  benchmarkOverlay?: {
    label: string;
    points: DrawdownSeriesPoint[];
    maxDrawdownPercent: string | null;
  } | null;
}

/**
 * Underwater Drawdown Chart built on Lightweight Charts v5 showing percentage
 * decline below the running historical high-water mark, with exact peak,
 * trough, and recovery dates.
 */
export function DrawdownChart({
  portfolioDrawdown,
  benchmarkOverlay = null,
}: DrawdownChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { palette, themeTick } = useChartThemePalette();
  const [hovered, setHovered] = useState<{
    date: string;
    portfolio: number | null;
    benchmark: number | null;
  } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || portfolioDrawdown.points.length < 2) {
      return;
    }

    const chart: IChartApi = createChart(el, {
      width: el.clientWidth,
      height: 220,
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
        scaleMargins: { top: 0.05, bottom: 0.08 },
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

    const pData = portfolioDrawdown.points.map((pt) => ({
      time: pt.date,
      value: Number(pt.drawdownPercent),
    }));
    const pLookup = new Map(pData.map((d) => [d.time, d.value]));

    const areaSeries = chart.addSeries(AreaSeries, {
      lineColor: palette.loss,
      topColor: colorWithAlpha(palette.loss, 0.04),
      bottomColor: colorWithAlpha(palette.loss, 0.28),
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    areaSeries.setData(pData);

    const bLookup = new Map<string, number>();
    if (benchmarkOverlay && benchmarkOverlay.points.length >= 2) {
      const minPortfolioDate = portfolioDrawdown.points[0]?.date;
      const bData = benchmarkOverlay.points
        .filter((pt) => !minPortfolioDate || pt.date >= minPortfolioDate)
        .map((pt) => ({
          time: pt.date,
          value: Number(pt.drawdownPercent),
        }));
      for (const pt of bData) {
        bLookup.set(pt.time, pt.value);
      }
      if (bData.length >= 2) {
        const benchLine = chart.addSeries(LineSeries, {
          color: palette.ink3,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        benchLine.setData(bData);
      }
    }

    chart.timeScale().fitContent();

    chart.subscribeCrosshairMove((param) => {
      if (!param.time) {
        setHovered(null);
        return;
      }
      const dateStr = String(param.time);
      setHovered({
        date: dateStr,
        portfolio: pLookup.get(dateStr) ?? null,
        benchmark: bLookup.get(dateStr) ?? null,
      });
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
  }, [portfolioDrawdown.points, benchmarkOverlay, palette, themeTick]);

  if (portfolioDrawdown.points.length < 2) {
    return (
      <div className="flex h-48 items-center justify-center rounded-[12px] border border-dashed border-line bg-surface-2 px-4 text-center text-[13px] text-ink-2">
        Not enough active valuation history to plot underwater drawdowns.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="min-h-[40px] flex flex-wrap items-center justify-between gap-3 text-[12.5px]">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="inline-flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: palette.loss }}
            />
            <span className="font-medium text-ink">Portfolio Drawdown</span>
            <span className="num text-loss font-medium">
              {hovered?.portfolio !== null && hovered?.portfolio !== undefined
                ? formatPercent(hovered.portfolio)
                : portfolioDrawdown.currentDrawdownPercent
                  ? `${formatPercent(portfolioDrawdown.currentDrawdownPercent)} current`
                  : "0.00%"}
            </span>
          </span>

          {benchmarkOverlay && (
            <span className="inline-flex items-center gap-1.5 text-ink-2">
              <span className="h-1.5 w-3 border-t-2 border-dashed border-ink-3" />
              <span>{benchmarkOverlay.label}</span>
              {hovered?.benchmark !== null && hovered?.benchmark !== undefined ? (
                <span className="num">{formatPercent(hovered.benchmark)}</span>
              ) : benchmarkOverlay.maxDrawdownPercent ? (
                <span className="num text-ink-2">
                  max {formatPercent(benchmarkOverlay.maxDrawdownPercent)}
                </span>
              ) : null}
            </span>
          )}
        </div>

        <div className="text-[12px] text-ink-2">
          {hovered ? (
            <span>
              Date: <span className="font-mono">{hovered.date}</span>
            </span>
          ) : (
            <span>
              Max{" "}
              <strong className="num font-semibold text-loss">
                {portfolioDrawdown.maxDrawdownPercent
                  ? formatPercent(portfolioDrawdown.maxDrawdownPercent)
                  : "0.00%"}
              </strong>
              {portfolioDrawdown.peakDate && portfolioDrawdown.troughDate ? (
                <>
                  {" · Peak "}
                  <span className="font-mono">{portfolioDrawdown.peakDate}</span>
                  {" -> Trough "}
                  <span className="font-mono">{portfolioDrawdown.troughDate}</span>
                  {" · "}
                  {portfolioDrawdown.recoveryDate ? (
                    <>
                      Recovered{" "}
                      <span className="font-mono">
                        {portfolioDrawdown.recoveryDate}
                      </span>
                    </>
                  ) : (
                    "Not yet recovered"
                  )}
                </>
              ) : (
                ""
              )}
            </span>
          )}
        </div>
      </div>

      <div
        ref={containerRef}
        className="w-full"
        aria-label="Portfolio underwater drawdown chart"
      />
    </div>
  );
}
