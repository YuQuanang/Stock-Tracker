"use client";

import { useEffect, useState } from "react";

export interface ChartThemePalette {
  bg: string;
  ink: string;
  ink2: string;
  ink3: string;
  line: string;
  grid: string;
  accent: string;
  gain: string;
  loss: string;
  surface: string;
  surface2: string;
}

const DARK_FALLBACK_PALETTE: ChartThemePalette = {
  bg: "#0E1117",
  ink: "#E8ECF1",
  ink2: "#9AA4B2",
  ink3: "#6B7686",
  line: "#262D38",
  grid: "#1F2630",
  accent: "#5B8DEF",
  gain: "#22C55E",
  loss: "#EF4444",
  surface: "#161B22",
  surface2: "#1C222B",
};

/**
 * Distinct high-contrast palette for multi-slice allocation donuts and multi-line
 * benchmark overlays (`#5B8DEF` accent reserved for Portfolio / primary line).
 */
export const SERIES_PALETTE = [
  "#5B8DEF", // Primary accent blue (Portfolio)
  "#A78BFA", // Violet
  "#F59E0B", // Amber
  "#38BDF8", // Sky cyan
  "#2DD4BF", // Teal
  "#FB7185", // Coral rose
  "#818CF8", // Indigo
  "#94A3B8", // Cool slate
  "#6B7686", // Muted steel ("Other")
] as const;

export function readChartThemePalette(): ChartThemePalette {
  if (typeof window === "undefined") {
    return DARK_FALLBACK_PALETTE;
  }
  const styles = window.getComputedStyle(document.documentElement);
  return {
    bg: styles.getPropertyValue("--bg").trim() || DARK_FALLBACK_PALETTE.bg,
    ink: styles.getPropertyValue("--ink").trim() || DARK_FALLBACK_PALETTE.ink,
    ink2: styles.getPropertyValue("--ink-2").trim() || DARK_FALLBACK_PALETTE.ink2,
    ink3: styles.getPropertyValue("--ink-3").trim() || DARK_FALLBACK_PALETTE.ink3,
    line: styles.getPropertyValue("--line").trim() || DARK_FALLBACK_PALETTE.line,
    grid: styles.getPropertyValue("--grid").trim() || DARK_FALLBACK_PALETTE.grid,
    accent:
      styles.getPropertyValue("--accent").trim() ||
      DARK_FALLBACK_PALETTE.accent,
    gain: styles.getPropertyValue("--gain").trim() || DARK_FALLBACK_PALETTE.gain,
    loss: styles.getPropertyValue("--loss").trim() || DARK_FALLBACK_PALETTE.loss,
    surface:
      styles.getPropertyValue("--surface").trim() ||
      DARK_FALLBACK_PALETTE.surface,
    surface2:
      styles.getPropertyValue("--surface-2").trim() ||
      DARK_FALLBACK_PALETTE.surface2,
  };
}

/**
 * Returns a reactive CSS custom-property theme tick and resolved palette that
 * stays synchronized whenever `data-theme`, `data-gain-scheme`, or OS color
 * scheme changes. Starts from `DARK_FALLBACK_PALETTE` identically on SSR and
 * first client render to avoid React hydration mismatches, then syncs after mount.
 */
export function useChartThemePalette(): {
  palette: ChartThemePalette;
  themeTick: number;
} {
  const [palette, setPalette] = useState<ChartThemePalette>(
    DARK_FALLBACK_PALETTE,
  );
  const [themeTick, setThemeTick] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const sync = () => {
      setPalette(readChartThemePalette());
      setThemeTick((t) => t + 1);
    };

    sync();

    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-gain-scheme"],
    });

    const mql = window.matchMedia?.("(prefers-color-scheme: dark)");
    mql?.addEventListener?.("change", sync);

    return () => {
      observer.disconnect();
      mql?.removeEventListener?.("change", sync);
    };
  }, []);

  return { palette, themeTick };
}

/** Converts a CSS `#rrggbb` hex or `rgb(...)` color into an `rgba(..., alpha)` string for canvas fills. */
export function colorWithAlpha(cssColor: string, alpha: number): string {
  const trimmed = cssColor.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) {
    const r = Number.parseInt(trimmed.slice(1, 3), 16);
    const g = Number.parseInt(trimmed.slice(3, 5), 16);
    const b = Number.parseInt(trimmed.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const rgbMatch = trimmed.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (rgbMatch) {
    return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${alpha})`;
  }
  return `rgba(91, 141, 239, ${alpha})`;
}

/** Filters daily `{ date, ... }` arrays by standard chart horizon windows. */
export type AnalyticsChartRange =
  | "1M"
  | "3M"
  | "6M"
  | "YTD"
  | "1Y"
  | "3Y"
  | "5Y"
  | "MAX";

export const ANALYTICS_RANGE_OPTIONS: readonly AnalyticsChartRange[] = [
  "1M",
  "3M",
  "6M",
  "YTD",
  "1Y",
  "3Y",
  "5Y",
  "MAX",
];

export function filterPointsByAnalyticsRange<T extends { date: string }>(
  points: readonly T[],
  range: AnalyticsChartRange,
): T[] {
  if (points.length === 0 || range === "MAX") {
    return [...points];
  }
  const latestDate = points[points.length - 1].date;
  const [y, m, d] = latestDate.split("-").map(Number);
  let cutoff = latestDate;

  switch (range) {
    case "1M":
      cutoff = new Date(Date.UTC(y, m - 2, d)).toISOString().slice(0, 10);
      break;
    case "3M":
      cutoff = new Date(Date.UTC(y, m - 4, d)).toISOString().slice(0, 10);
      break;
    case "6M":
      cutoff = new Date(Date.UTC(y, m - 7, d)).toISOString().slice(0, 10);
      break;
    case "YTD":
      cutoff = `${String(y).padStart(4, "0")}-01-01`;
      break;
    case "1Y":
      cutoff = new Date(Date.UTC(y - 1, m - 1, d)).toISOString().slice(0, 10);
      break;
    case "3Y":
      cutoff = new Date(Date.UTC(y - 3, m - 1, d)).toISOString().slice(0, 10);
      break;
    case "5Y":
      cutoff = new Date(Date.UTC(y - 5, m - 1, d)).toISOString().slice(0, 10);
      break;
  }

  const sliced = points.filter((p) => p.date >= cutoff);
  return sliced.length >= 2 ? sliced : [...points];
}
