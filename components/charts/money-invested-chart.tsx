"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AreaSeries,
  ColorType,
  createChart,
  CrosshairMode,
  type IChartApi,
  LineStyle,
} from "lightweight-charts";
import {
  TradeMarkersPrimitive,
  type TradeMarkerPalette,
  type TradeMarkerPoint,
} from "@/components/charts/trade-markers-primitive";
import {
  type AnalyticsChartRange,
  type ChartThemePalette,
  filterPointsByAnalyticsRange,
  useChartThemePalette,
} from "@/lib/charts/theme";
import { formatMoney } from "@/lib/format";
import { formatSymbolForDisplay } from "@/lib/transactions/form-logic";

export interface MoneyInvestedPoint {
  date: string;
  netCashInvested: string;
}

export interface MoneyInvestedTradeEvent {
  date: string;
  tradeDate: string;
  kind: "buy" | "sell";
  symbol: string;
  amountInBase: string;
}

interface MoneyInvestedChartProps {
  points: readonly MoneyInvestedPoint[];
  tradeEvents: readonly MoneyInvestedTradeEvent[];
  currency: "SGD" | "USD";
  range: AnalyticsChartRange;
}

interface HoveredInvestedState {
  date: string;
  netCashInvested: number;
  summaryText: string | null;
}

function buildCashFlowMarkerPalette(theme: ChartThemePalette): TradeMarkerPalette {
  return {
    buy: theme.accent,
    sell: "#F59E0B",
    dividend: theme.ink3,
    mixed: theme.ink2,
    ring: theme.surface,
    glyph: theme.bg,
  };
}

/**
 * Compact cumulative net-money-invested chart with Buy and Sell markers
 * placed directly below Portfolio Value charts to highlight deposit/withdrawal timing.
 */
export function MoneyInvestedChart({
  points,
  tradeEvents,
  currency,
  range,
}: MoneyInvestedChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { palette, themeTick } = useChartThemePalette();
  const [hovered, setHovered] = useState<HoveredInvestedState | null>(null);

  const visiblePoints = useMemo(
    () => filterPointsByAnalyticsRange(points, range),
    [points, range],
  );

  const tradeCountsInWindow = useMemo(() => {
    if (visiblePoints.length === 0) {
      return { buys: 0, sells: 0 };
    }
    const minDate = visiblePoints[0].date;
    const maxDate = visiblePoints[visiblePoints.length - 1].date;
    let buys = 0;
    let sells = 0;
    for (const ev of tradeEvents) {
      if (ev.date < minDate || ev.date > maxDate) continue;
      if (ev.kind === "buy") buys += 1;
      else sells += 1;
    }
    return { buys, sells };
  }, [tradeEvents, visiblePoints]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || visiblePoints.length === 0) {
      return;
    }

    const chart: IChartApi = createChart(el, {
      width: el.clientWidth,
      height: 175,
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
        scaleMargins: { top: 0.14, bottom: 0.1 },
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

    const areaSeries = chart.addSeries(AreaSeries, {
      lineColor: palette.ink2,
      lineWidth: 2,
      topColor: "rgba(154, 164, 178, 0.22)",
      bottomColor: "rgba(154, 164, 178, 0.02)",
      priceLineVisible: false,
      lastValueVisible: true,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });

    const seriesData = visiblePoints.map((p) => ({
      time: p.date,
      value: Number(p.netCashInvested),
    }));
    areaSeries.setData(seriesData);

    const valueByDate = new Map<string, number>();
    for (const p of seriesData) {
      valueByDate.set(p.time, p.value);
    }

    const markers: TradeMarkerPoint[] = [];
    const descriptionsByDate = new Map<string, string[]>();
    for (const ev of tradeEvents) {
      const yVal = valueByDate.get(ev.date);
      if (yVal === undefined || !Number.isFinite(yVal)) {
        continue;
      }
      markers.push({
        time: ev.date,
        price: yVal,
        kind: ev.kind,
      });
      const verb = ev.kind === "buy" ? "Buy" : "Sell";
      const label = `${verb} ${formatSymbolForDisplay(ev.symbol)} (${formatMoney(ev.amountInBase, currency)})`;
      const list = descriptionsByDate.get(ev.date) ?? [];
      list.push(label);
      descriptionsByDate.set(ev.date, list);
    }

    const markerPalette = buildCashFlowMarkerPalette(palette);
    const tradeMarkers = new TradeMarkersPrimitive(markerPalette);
    areaSeries.attachPrimitive(tradeMarkers);
    tradeMarkers.setData(markers, markerPalette);

    chart.timeScale().fitContent();

    chart.subscribeCrosshairMove((param) => {
      if (!param.time) {
        tradeMarkers.setActiveTime(null);
        setHovered(null);
        return;
      }
      const key = String(param.time);
      const val = valueByDate.get(key);
      if (val === undefined) {
        tradeMarkers.setActiveTime(null);
        setHovered(null);
        return;
      }
      tradeMarkers.setActiveTime(key);
      const notes = descriptionsByDate.get(key);
      const summaryText =
        notes && notes.length > 0
          ? notes.length <= 2
            ? notes.join(" · ")
            : `${notes.slice(0, 2).join(" · ")} +${notes.length - 2} more`
          : null;
      setHovered({
        date: key,
        netCashInvested: val,
        summaryText,
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
  }, [visiblePoints, tradeEvents, currency, palette, themeTick]);

  if (visiblePoints.length === 0) {
    return null;
  }

  const latestPoint = visiblePoints[visiblePoints.length - 1];
  const displayedAmount = hovered
    ? hovered.netCashInvested
    : Number(latestPoint.netCashInvested);

  return (
    <div className="space-y-2 border-t border-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[13.5px] font-semibold text-ink">
              Cumulative net money invested ({currency})
            </h3>
            <span className="num text-[13px] font-medium text-ink-2">
              {formatMoney(displayedAmount, currency)}
            </span>
          </div>
          <p className="min-h-[18px] text-[11.5px] text-ink-3">
            {hovered ? (
              <>
                <span className="font-mono text-ink-2">{hovered.date}</span>
                {hovered.summaryText ? (
                  <>
                    {" · "}
                    <span className="text-ink-2">{hovered.summaryText}</span>
                  </>
                ) : (
                  " · Buys minus sells"
                )}
              </>
            ) : (
              "Buys add cash invested; sells reduce net cash invested."
            )}
          </p>
        </div>

        <div className="flex items-center gap-3 text-[11.5px] text-ink-2">
          <span className="inline-flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: palette.accent }}
            />
            Buys ({tradeCountsInWindow.buys})
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: "#F59E0B" }}
            />
            Sells ({tradeCountsInWindow.sells})
          </span>
        </div>
      </div>

      <div
        ref={containerRef}
        className="w-full"
        aria-label={`Cumulative net money invested chart in ${currency}`}
      />
    </div>
  );
}
