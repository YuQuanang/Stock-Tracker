"use client";

/**
 * Interactive Price Chart (`components/charts/interactive-price-chart.tsx`).
 *
 * Built on TradingView Lightweight Charts v5 (Apache-2.0):
 *  - Range selector: `1D`, `5D`, `1M`, `6M`, `YTD`, `1Y`, `5Y`, `MAX`
 *  - Smooth gradient area series coloured by range performance (`--gain` / `--loss`)
 *  - Optional dashed Average Cost horizontal price line (`averageCostPerShare`)
 *  - Optional Buy / Sell / Dividend markers (`createSeriesMarkers`)
 *  - Crosshair scrubbing readout with instant snap-back
 *  - Screen-reader summary of period high, low, start, and end
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AreaSeries,
  ColorType,
  createChart,
  CrosshairMode,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  LineStyle,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  type TradeMarkerKind,
  type TradeMarkerPalette,
  type TradeMarkerPoint,
  TradeMarkersPrimitive,
} from "@/components/charts/trade-markers-primitive";
import { Card } from "@/components/ui/card";
import { GainBadge } from "@/components/ui/gain-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMoney, formatQuantity } from "@/lib/format";
import type {
  ChartRange,
  HistoricalPricePoint,
  PriceHistoryResult,
} from "@/lib/market-data/history";
import type { EnrichedTransactionRow } from "@/lib/services/ledger";

const RANGE_OPTIONS: ChartRange[] = [
  "1D",
  "5D",
  "1M",
  "6M",
  "YTD",
  "1Y",
  "5Y",
  "MAX",
];

interface InteractivePriceChartProps {
  symbol: string;
  currency: string;
  initialHistory: PriceHistoryResult;
  averageCostPerShare: string | null;
  transactions: readonly EnrichedTransactionRow[];
}

interface ScannedThemeColors {
  ink2: string;
  ink3: string;
  line: string;
  accent: string;
  gain: string;
  loss: string;
  surface: string;
}

function readThemePalette(): ScannedThemeColors {
  if (typeof window === "undefined") {
    return {
      ink2: "#55555b",
      ink3: "#6e6e75",
      line: "rgba(60, 60, 67, 0.14)",
      accent: "#0071e3",
      gain: "#1a7f37",
      loss: "#c4281c",
      surface: "#ffffff",
    };
  }
  const styles = window.getComputedStyle(document.documentElement);
  return {
    ink2: styles.getPropertyValue("--ink-2").trim() || "#55555b",
    ink3: styles.getPropertyValue("--ink-3").trim() || "#6e6e75",
    line: styles.getPropertyValue("--line").trim() || "rgba(60, 60, 67, 0.14)",
    accent: styles.getPropertyValue("--accent").trim() || "#0071e3",
    gain: styles.getPropertyValue("--gain").trim() || "#1a7f37",
    loss: styles.getPropertyValue("--loss").trim() || "#c4281c",
    surface: styles.getPropertyValue("--surface").trim() || "#ffffff",
  };
}

/** Apple system colours for trade badges (same hues in light and dark mode). */
function buildMarkerPalette(theme: ScannedThemeColors): TradeMarkerPalette {
  return {
    buy: "#0a84ff",
    sell: "#ff9f0a",
    dividend: "#bf5af2",
    mixed: theme.ink2,
    ring: theme.surface,
    glyph: "#ffffff",
  };
}

interface TradeEvent {
  /** Daily bar date (`YYYY-MM-DD`) the trade snaps to. */
  barDate: string;
  kind: TradeMarkerKind;
  description: string;
}

function withAlpha(hexOrRgb: string, alpha: number): string {
  const trimmed = hexOrRgb.trim();
  if (trimmed.startsWith("#") && (trimmed.length === 7 || trimmed.length === 4)) {
    let r = 0;
    let g = 0;
    let b = 0;
    if (trimmed.length === 7) {
      r = Number.parseInt(trimmed.slice(1, 3), 16);
      g = Number.parseInt(trimmed.slice(3, 5), 16);
      b = Number.parseInt(trimmed.slice(5, 7), 16);
    } else {
      r = Number.parseInt(trimmed[1] + trimmed[1], 16);
      g = Number.parseInt(trimmed[2] + trimmed[2], 16);
      b = Number.parseInt(trimmed[3] + trimmed[3], 16);
    }
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return trimmed;
}

function formatPointTimeForHeader(point: HistoricalPricePoint): string {
  if (typeof point.time === "number") {
    return new Intl.DateTimeFormat("en-SG", {
      timeZone: "Asia/Singapore",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(point.time * 1000));
  }
  return point.date;
}

export function InteractivePriceChart({
  symbol,
  currency,
  initialHistory,
  averageCostPerShare,
  transactions,
}: InteractivePriceChartProps) {
  const [selectedRange, setSelectedRange] = useState<ChartRange>(
    initialHistory.range ?? "1Y",
  );
  const [historyCache, setHistoryCache] = useState<
    Partial<Record<ChartRange, PriceHistoryResult>>
  >(() => ({
    [initialHistory.range ?? "1Y"]: initialHistory,
  }));
  const [isLoadingRange, setIsLoadingRange] = useState(false);
  const [showTradeMarkers, setShowTradeMarkers] = useState(true);
  const [showAvgCostLine, setShowAvgCostLine] = useState(true);
  const [scrubPoint, setScrubPoint] = useState<{
    price: number;
    label: string;
    /** Trade descriptions on this bar (e.g. `Buy 3 sh @ US$14.50`). */
    trades: string[];
  } | null>(null);
  const [themeTick, setThemeTick] = useState(0);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area", Time> | null>(null);
  const tradeMarkersRef = useRef<TradeMarkersPrimitive | null>(null);
  const avgCostLineRef = useRef<IPriceLine | null>(null);

  const activeHistory = historyCache[selectedRange];

  // Fetch uncached ranges on demand
  useEffect(() => {
    if (historyCache[selectedRange]) {
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    queueMicrotask(() => {
      if (!cancelled) {
        setIsLoadingRange(true);
      }
    });

    fetch(
      `/api/market/history?symbol=${encodeURIComponent(
        symbol,
      )}&range=${encodeURIComponent(selectedRange)}`,
      { signal: controller.signal, cache: "no-store" },
    )
      .then(async (res) => {
        if (!res.ok) {
          throw new Error("Failed to load range");
        }
        const payload = (await res.json()) as { history: PriceHistoryResult };
        if (!cancelled) {
          setHistoryCache((prev) => ({
            ...prev,
            [selectedRange]: payload.history,
          }));
        }
      })
      .catch(() => {
        // Keep unavailable fallback state if network fails
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingRange(false);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [selectedRange, symbol, historyCache]);

  // Observe root theme / gain-scheme changes so canvas colours stay synchronized
  useEffect(() => {
    if (typeof MutationObserver === "undefined") {
      return;
    }
    const observer = new MutationObserver(() => {
      setThemeTick((t) => t + 1);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-gain-scheme"],
    });
    return () => observer.disconnect();
  }, []);

  const normalizedSeriesData = useMemo(() => {
    const bars = activeHistory?.bars ?? [];
    const seen = new Set<string | number>();
    const points: {
      time: Time;
      value: number;
      raw: HistoricalPricePoint;
    }[] = [];

    for (const bar of bars) {
      const val = Number(bar.close);
      if (!Number.isFinite(val)) {
        continue;
      }
      const key = bar.time;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const timeVal: Time =
        typeof bar.time === "number"
          ? (bar.time as UTCTimestamp)
          : bar.date;
      points.push({ time: timeVal, value: val, raw: bar });
    }
    return points;
  }, [activeHistory]);

  const periodStats = useMemo(() => {
    if (normalizedSeriesData.length === 0) {
      return null;
    }
    const first = normalizedSeriesData[0];
    const last = normalizedSeriesData[normalizedSeriesData.length - 1];
    const values = normalizedSeriesData.map((d) => d.value);
    const high = Math.max(...values);
    const low = Math.min(...values);
    const change = last.value - first.value;
    const changePct = first.value > 0 ? (change / first.value) * 100 : null;
    return {
      first,
      last,
      high,
      low,
      change,
      changePct,
    };
  }, [normalizedSeriesData]);

  /**
   * Trades snapped to the nearest bar at or before the trade date. Only daily
   * ranges get markers (intraday bars cannot place a daily trade honestly).
   */
  const tradeEvents = useMemo<TradeEvent[]>(() => {
    if (activeHistory?.interval !== "1d" || normalizedSeriesData.length === 0) {
      return [];
    }

    const barDates = normalizedSeriesData.map((d) => String(d.time)).sort();
    const minBarDate = barDates[0];
    const maxBarDate = barDates[barDates.length - 1];

    function snapToBarDate(localDate: string): string | null {
      if (localDate < minBarDate || localDate > maxBarDate) {
        return null;
      }
      for (let i = barDates.length - 1; i >= 0; i -= 1) {
        if (barDates[i] <= localDate) {
          return barDates[i];
        }
      }
      return null;
    }

    const events: TradeEvent[] = [];
    const sorted = [...transactions].sort((a, b) =>
      a.localDate.localeCompare(b.localDate),
    );

    for (const tx of sorted) {
      const barDate = snapToBarDate(tx.localDate);
      if (!barDate) {
        continue;
      }
      const priceText = formatMoney(tx.price, currency, {
        maximumFractionDigits: 4,
      });

      if (tx.type === "Buy") {
        events.push({
          barDate,
          kind: "buy",
          description: `Bought ${formatQuantity(tx.quantity)} sh @ ${priceText}`,
        });
      } else if (tx.type === "Sell") {
        events.push({
          barDate,
          kind: "sell",
          description: `Sold ${formatQuantity(tx.quantity)} sh @ ${priceText}`,
        });
      } else if (tx.type === "Sell All") {
        events.push({
          barDate,
          kind: "sell",
          description: `Sold all @ ${priceText}`,
        });
      } else if (tx.type === "Dividend") {
        events.push({
          barDate,
          kind: "dividend",
          description: `Dividend ${formatMoney(tx.quantity, currency)}`,
        });
      }
    }
    return events;
  }, [activeHistory?.interval, normalizedSeriesData, transactions, currency]);

  // Create chart instance once on mount
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const palette = readThemePalette();
    const chart = createChart(container, {
      width: container.clientWidth,
      height: 310,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: palette.ink3,
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, sans-serif',
        fontSize: 11.5,
        // Attribution is shown as a text link under the chart instead of the
        // logo, which would otherwise sit on top of the price line.
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: palette.line, style: LineStyle.Solid },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.12, bottom: 0.1 },
      },
      timeScale: {
        borderVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
        timeVisible: selectedRange === "1D" || selectedRange === "5D",
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: {
          color: palette.ink3,
          width: 1,
          style: LineStyle.Dashed,
          labelVisible: false,
        },
        horzLine: {
          color: palette.ink3,
          width: 1,
          style: LineStyle.Dashed,
        },
      },
      handleScroll: {
        mouseWheel: false,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: false,
        mouseWheel: false,
        pinch: true,
      },
    });

    const series = chart.addSeries(AreaSeries, {
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    const tradeMarkers = new TradeMarkersPrimitive(
      buildMarkerPalette(readThemePalette()),
    );
    series.attachPrimitive(tradeMarkers);

    chartRef.current = chart;
    seriesRef.current = series;
    tradeMarkersRef.current = tradeMarkers;

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry && chartRef.current) {
        chartRef.current.applyOptions({
          width: Math.max(240, Math.floor(entry.contentRect.width)),
        });
      }
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      tradeMarkersRef.current = null;
      avgCostLineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Synchronize data, colours, markers, crosshair listener, and Avg Cost line
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const tradeMarkers = tradeMarkersRef.current;
    if (!chart || !series || !tradeMarkers) {
      return;
    }

    const palette = readThemePalette();
    const isUp = (periodStats?.change ?? 0) >= 0;
    const lineColor = isUp ? palette.gain : palette.loss;

    chart.applyOptions({
      layout: { textColor: palette.ink3 },
      grid: { horzLines: { color: palette.line } },
      timeScale: {
        timeVisible: selectedRange === "1D" || selectedRange === "5D",
      },
    });

    series.applyOptions({
      lineColor,
      topColor: withAlpha(lineColor, 0.24),
      bottomColor: withAlpha(lineColor, 0.0),
    });

    series.setData(
      normalizedSeriesData.map((d) => ({ time: d.time, value: d.value })),
    );
    chart.timeScale().fitContent();

    // Remove previous average-cost price line before re-creating
    if (avgCostLineRef.current) {
      series.removePriceLine(avgCostLineRef.current);
      avgCostLineRef.current = null;
    }

    const avgCostNum = averageCostPerShare ? Number(averageCostPerShare) : Number.NaN;
    if (showAvgCostLine && Number.isFinite(avgCostNum) && avgCostNum > 0) {
      avgCostLineRef.current = series.createPriceLine({
        price: avgCostNum,
        color: palette.accent,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "Avg cost",
      });
    }

    const pointByTimeKey = new Map<string, HistoricalPricePoint>();
    for (const item of normalizedSeriesData) {
      pointByTimeKey.set(String(item.time), item.raw);
    }

    const tradesByDate = new Map<string, string[]>();
    const markerPoints: TradeMarkerPoint[] = [];

    for (const event of tradeEvents) {
      const bar = pointByTimeKey.get(event.barDate);
      if (!bar) {
        continue;
      }
      const close = Number(bar.close);
      if (!Number.isFinite(close)) {
        continue;
      }
      const list = tradesByDate.get(event.barDate) ?? [];
      list.push(event.description);
      tradesByDate.set(event.barDate, list);
      markerPoints.push({
        time: event.barDate,
        price: close,
        kind: event.kind,
      });
    }

    tradeMarkers.setData(
      showTradeMarkers ? markerPoints : [],
      buildMarkerPalette(palette),
    );

    function handleCrosshairMove(param: {
      time?: Time;
      seriesData: Map<unknown, unknown>;
    }): void {
      if (!param.time) {
        tradeMarkers?.setActiveTime(null);
        setScrubPoint(null);
        return;
      }
      const timeKey = String(param.time);
      const rawPoint = pointByTimeKey.get(timeKey);
      if (!rawPoint) {
        tradeMarkers?.setActiveTime(null);
        setScrubPoint(null);
        return;
      }
      tradeMarkers?.setActiveTime(param.time);
      setScrubPoint({
        price: Number(rawPoint.close),
        label: formatPointTimeForHeader(rawPoint),
        trades: tradesByDate.get(timeKey) ?? [],
      });
    }

    chart.subscribeCrosshairMove(handleCrosshairMove);
    return () => {
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
    };
  }, [
    normalizedSeriesData,
    periodStats,
    selectedRange,
    averageCostPerShare,
    showAvgCostLine,
    showTradeMarkers,
    tradeEvents,
    themeTick,
  ]);

  const hasBars = normalizedSeriesData.length > 0;

  return (
    <Card className="p-4 sm:p-6">
      {/* Header row: Range change readout + Range selector pills */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Fixed 44px height (`h-11` = 24px top row + 20px bottom row) so
            scrubbing never shifts the chart or cards below by even 1px. */}
        <div className="flex h-11 min-w-0 flex-1 flex-col justify-between overflow-hidden">
          {scrubPoint ? (
            <>
              <div className="flex h-6 items-center gap-2">
                <span className="num text-[17px] leading-6 font-semibold tracking-tight text-ink">
                  {formatMoney(scrubPoint.price, currency, {
                    maximumFractionDigits: 4,
                  })}
                </span>
                {scrubPoint.trades.length > 0 && (
                  <span className="truncate rounded-full bg-surface-2 px-2 py-0.5 text-[11.5px] leading-4 font-medium text-ink">
                    {scrubPoint.trades.join(" · ")}
                  </span>
                )}
              </div>
              <p className="num h-5 truncate text-[12px] leading-5 text-ink-3">
                {scrubPoint.label}
              </p>
            </>
          ) : periodStats ? (
            <>
              <div className="flex h-6 items-center gap-2">
                <span className="whitespace-nowrap text-[12.5px] leading-6 font-medium text-ink-3">
                  {selectedRange} range change
                </span>
                <GainBadge
                  amount={periodStats.change}
                  currency={currency}
                  percent={periodStats.changePct}
                  size="sm"
                  pill
                />
              </div>
              <p className="num h-5 truncate text-[12px] leading-5 text-ink-3">
                Low {formatMoney(periodStats.low, currency)} · High{" "}
                {formatMoney(periodStats.high, currency)}
                {activeHistory?.status === "stale_cache"
                  ? " · Cached history (offline)"
                  : ""}
              </p>
            </>
          ) : (
            <div className="flex h-11 items-center">
              <p className="truncate text-[13px] text-ink-3">
                {isLoadingRange
                  ? `Loading ${selectedRange} chart…`
                  : (activeHistory?.unavailableReason ??
                    "Historical chart unavailable for this instrument.")}
              </p>
            </div>
          )}
        </div>

        {/* Apple-style compact range bar */}
        <div
          role="group"
          aria-label="Chart time range"
          className="inline-flex shrink-0 flex-wrap items-center gap-1 rounded-[11px] bg-surface-2 p-1"
        >
          {RANGE_OPTIONS.map((range) => {
            const active = selectedRange === range;
            return (
              <button
                key={range}
                type="button"
                onClick={() => {
                  setScrubPoint(null);
                  setSelectedRange(range);
                }}
                aria-pressed={active}
                className={`num rounded-[8px] px-2.5 py-1 text-[12px] font-semibold transition-colors ${
                  active
                    ? "bg-surface text-ink shadow-xs"
                    : "text-ink-3 hover:text-ink"
                }`}
              >
                {range}
              </button>
            );
          })}
        </div>
      </div>

      {/* Chart Canvas Area */}
      <div className="relative mt-3 min-h-[310px] w-full">
        {isLoadingRange && !hasBars && (
          <Skeleton className="absolute inset-0 h-[310px] w-full rounded-[14px]" />
        )}

        {!isLoadingRange && !hasBars && (
          <div className="flex h-[310px] items-center justify-center rounded-[14px] border border-dashed border-line px-4 text-center text-[13.5px] text-ink-3">
            {activeHistory?.unavailableReason ??
              `No historical chart bars available for ${symbol}.`}
          </div>
        )}

        <div
          ref={containerRef}
          aria-label={`${symbol} ${selectedRange} price chart`}
          className={hasBars ? "w-full" : "pointer-events-none h-0 overflow-hidden opacity-0"}
        />
      </div>

      {/* Accessible screen-reader summary of chart series */}
      {periodStats && (
        <p className="sr-only">
          {symbol} {selectedRange} price series from{" "}
          {formatPointTimeForHeader(periodStats.first.raw)} (
          {formatMoney(periodStats.first.value, currency)}) to{" "}
          {formatPointTimeForHeader(periodStats.last.raw)} (
          {formatMoney(periodStats.last.value, currency)}). Period low{" "}
          {formatMoney(periodStats.low, currency)}, period high{" "}
          {formatMoney(periodStats.high, currency)}.
        </p>
      )}

      {/* Chart overlay toggles + Apple badge legend + TradingView attribution */}
      {hasBars && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2.5 border-t border-line pt-3 text-[12px]">
          <div className="flex flex-wrap items-center gap-2">
            {tradeEvents.length > 0 && (
              <button
                type="button"
                onClick={() => setShowTradeMarkers((v) => !v)}
                aria-pressed={showTradeMarkers}
                className={`rounded-full border px-3 py-1 font-medium transition-colors ${
                  showTradeMarkers
                    ? "border-accent/40 bg-accent/10 text-accent"
                    : "border-line bg-surface-2 text-ink-3 hover:text-ink"
                }`}
              >
                Trade markers ({tradeEvents.length})
              </button>
            )}

            {averageCostPerShare && (
              <button
                type="button"
                onClick={() => setShowAvgCostLine((v) => !v)}
                aria-pressed={showAvgCostLine}
                className={`num rounded-full border px-3 py-1 font-medium transition-colors ${
                  showAvgCostLine
                    ? "border-accent/40 bg-accent/10 text-accent"
                    : "border-line bg-surface-2 text-ink-3 hover:text-ink"
                }`}
              >
                Avg cost ({formatMoney(averageCostPerShare, currency)})
              </button>
            )}

            {showTradeMarkers && tradeEvents.length > 0 && (
              <div
                aria-label="Trade marker legend"
                className="flex flex-wrap items-center gap-2.5 pl-1 text-[11.5px] text-ink-3"
              >
                <span className="inline-flex items-center gap-1">
                  <span
                    aria-hidden="true"
                    className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#0a84ff] text-[9px] font-bold text-white"
                  >
                    ↑
                  </span>
                  <span>Buy</span>
                </span>
                <span className="inline-flex items-center gap-1">
                  <span
                    aria-hidden="true"
                    className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#ff9f0a] text-[9px] font-bold text-white"
                  >
                    ↓
                  </span>
                  <span>Sell</span>
                </span>
                <span className="inline-flex items-center gap-1">
                  <span
                    aria-hidden="true"
                    className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#bf5af2] text-[9px] font-bold text-white"
                  >
                    $
                  </span>
                  <span>Div</span>
                </span>
              </div>
            )}
          </div>

          <a
            href="https://www.tradingview.com/lightweight-charts/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-ink-3 transition-colors hover:text-ink-2"
          >
            Charts by TradingView
          </a>
        </div>
      )}
    </Card>
  );
}

