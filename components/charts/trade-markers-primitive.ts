/**
 * Apple-style trade markers drawn as a Lightweight Charts v5 series primitive.
 *
 * Instead of text labels that collide ("Buy 3Buy 3Buy 3"), every trade is a
 * round badge centred on the price line with a soft surface-coloured ring and a
 * subtle shadow, so it stays readable on any background:
 *   - Buy      -> blue badge with an up arrow
 *   - Sell     -> orange badge with a down arrow
 *   - Dividend -> purple badge with a dollar sign
 * Badges that would overlap at the current zoom level merge into a single badge
 * showing a count. Details for a badge appear in the chart header on hover.
 */
import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";

export type TradeMarkerKind = "buy" | "sell" | "dividend";

export interface TradeMarkerPoint {
  /** Bar time (daily `YYYY-MM-DD`) the marker snaps to. */
  time: Time;
  /** Close price of that bar - the marker sits exactly on the line. */
  price: number;
  kind: TradeMarkerKind;
}

export interface TradeMarkerPalette {
  buy: string;
  sell: string;
  dividend: string;
  mixed: string;
  /** Ring colour; matches the card surface so badges look "cut out". */
  ring: string;
  glyph: string;
}

type DrawTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

interface PositionedBadge {
  x: number;
  y: number;
  count: number;
  kind: TradeMarkerKind | "mixed";
  isActive: boolean;
}

const BADGE_RADIUS = 9;
const CLUSTER_DISTANCE_PX = BADGE_RADIUS * 2 + 2;

class TradeMarkersRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly source: () => {
      badges: PositionedBadge[];
      palette: TradeMarkerPalette;
    },
  ) {}

  draw(target: DrawTarget): void {
    const { badges, palette } = this.source();
    if (badges.length === 0) {
      return;
    }

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      for (const badge of badges) {
        if (badge.x < -BADGE_RADIUS || badge.x > mediaSize.width + BADGE_RADIUS) {
          continue;
        }

        const radius = badge.isActive ? BADGE_RADIUS + 2 : BADGE_RADIUS;
        const fill = palette[badge.kind];

        // Soft shadow + ring so the badge reads clearly on top of the line.
        ctx.save();
        ctx.shadowColor = "rgba(0, 0, 0, 0.28)";
        ctx.shadowBlur = 6;
        ctx.shadowOffsetY = 1.5;
        ctx.beginPath();
        ctx.arc(badge.x, badge.y, radius + 2.5, 0, Math.PI * 2);
        ctx.fillStyle = palette.ring;
        ctx.fill();
        ctx.restore();

        ctx.beginPath();
        ctx.arc(badge.x, badge.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();

        ctx.strokeStyle = palette.glyph;
        ctx.fillStyle = palette.glyph;
        ctx.lineWidth = 1.9;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        if (badge.count > 1) {
          ctx.font =
            '700 11px -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, sans-serif';
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(badge.count), badge.x, badge.y + 0.5);
          continue;
        }

        if (badge.kind === "buy") {
          drawArrow(ctx, badge.x, badge.y, "up");
        } else if (badge.kind === "sell") {
          drawArrow(ctx, badge.x, badge.y, "down");
        } else {
          ctx.font =
            '700 11px -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, sans-serif';
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("$", badge.x, badge.y + 0.5);
        }
      }
    });
  }
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  direction: "up" | "down",
): void {
  // `sign` flips the vertical offsets so one set of coordinates draws both arrows.
  const sign = direction === "up" ? 1 : -1;
  const tipY = cy - 4.4 * sign;
  const tailY = cy + 4.2 * sign;
  const wingY = cy - 0.4 * sign;

  // Shaft
  ctx.beginPath();
  ctx.moveTo(cx, tailY);
  ctx.lineTo(cx, tipY);
  ctx.stroke();

  // Arrow head
  ctx.beginPath();
  ctx.moveTo(cx - 3.5, wingY);
  ctx.lineTo(cx, tipY);
  ctx.lineTo(cx + 3.5, wingY);
  ctx.stroke();
}

class TradeMarkersPaneView implements IPrimitivePaneView {
  private readonly rendererInstance: TradeMarkersRenderer;

  constructor(source: ConstructorParameters<typeof TradeMarkersRenderer>[0]) {
    this.rendererInstance = new TradeMarkersRenderer(source);
  }

  zOrder(): "top" {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer {
    return this.rendererInstance;
  }
}

export class TradeMarkersPrimitive implements ISeriesPrimitive<Time> {
  private markers: TradeMarkerPoint[] = [];
  private palette: TradeMarkerPalette;
  private activeTimeKey: string | null = null;
  private badges: PositionedBadge[] = [];
  private attachedParam: SeriesAttachedParameter<Time> | null = null;
  private series: ISeriesApi<"Area", Time> | null = null;
  private readonly view: TradeMarkersPaneView;

  constructor(palette: TradeMarkerPalette) {
    this.palette = palette;
    this.view = new TradeMarkersPaneView(() => ({
      badges: this.badges,
      palette: this.palette,
    }));
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.attachedParam = param;
    this.series = param.series as ISeriesApi<"Area", Time>;
    param.requestUpdate();
  }

  detached(): void {
    this.attachedParam = null;
    this.series = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }

  updateAllViews(): void {
    this.recomputeBadges();
  }

  setData(markers: TradeMarkerPoint[], palette: TradeMarkerPalette): void {
    this.markers = markers;
    this.palette = palette;
    this.attachedParam?.requestUpdate();
  }

  setActiveTime(time: Time | null): void {
    const nextKey = time === null ? null : String(time);
    if (nextKey === this.activeTimeKey) {
      return;
    }
    this.activeTimeKey = nextKey;
    this.attachedParam?.requestUpdate();
  }

  private recomputeBadges(): void {
    const param = this.attachedParam;
    const series = this.series;
    if (!param || !series || this.markers.length === 0) {
      this.badges = [];
      return;
    }

    const timeScale = param.chart.timeScale();
    const positioned: {
      x: number;
      y: number;
      kind: TradeMarkerKind;
      timeKey: string;
    }[] = [];

    for (const marker of this.markers) {
      const x = timeScale.timeToCoordinate(marker.time);
      const y = series.priceToCoordinate(marker.price);
      if (x === null || y === null) {
        continue;
      }
      positioned.push({
        x,
        y,
        kind: marker.kind,
        timeKey: String(marker.time),
      });
    }

    positioned.sort((a, b) => a.x - b.x);

    // Merge badges that would overlap at the current zoom into one count badge.
    const merged: PositionedBadge[] = [];
    let cluster: typeof positioned = [];

    function flush(activeKey: string | null): void {
      if (cluster.length === 0) {
        return;
      }
      const kinds = new Set(cluster.map((item) => item.kind));
      const avgX = cluster.reduce((sum, item) => sum + item.x, 0) / cluster.length;
      const avgY = cluster.reduce((sum, item) => sum + item.y, 0) / cluster.length;
      merged.push({
        x: avgX,
        y: avgY,
        count: cluster.length,
        kind: kinds.size === 1 ? cluster[0].kind : "mixed",
        isActive:
          activeKey !== null && cluster.some((item) => item.timeKey === activeKey),
      });
      cluster = [];
    }

    for (const item of positioned) {
      if (
        cluster.length > 0 &&
        item.x - cluster[cluster.length - 1].x > CLUSTER_DISTANCE_PX
      ) {
        flush(this.activeTimeKey);
      }
      cluster.push(item);
    }
    flush(this.activeTimeKey);

    this.badges = merged;
  }
}
