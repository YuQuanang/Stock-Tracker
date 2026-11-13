"use client";

import { useEffect, useMemo, useState } from "react";

export interface ChartThemePalette {
  ink: string;
  ink2: string;
  ink3: string;
  line: string;
  accent: string;
  gain: string;
  loss: string;
  surface: string;
  surface2: string;
}

const LIGHT_FALLBACK_PALETTE: ChartThemePalette = {
  ink: "#1d1d1f",
  ink2: "#55555b",
  ink3: "#6e6e75",
  line: "rgba(60, 60, 67, 0.14)",
  accent: "#0071e3",
  gain: "#1a7f37",
  loss: "#c4281c",
  surface: "#ffffff",
  surface2: "#f5f5f7",
};

/**
 * Distinct Apple-curated palette for categorical donut slices and benchmark
 * overlay lines (`0071e3` accent reserved for Portfolio when possible).
 */
export const SERIES_PALETTE = [
  "#0071e3", // Apple blue
  "#af52de", // System purple
  "#ff9500", // System orange
  "#30b0c7", // System teal
  "#5856d6", // System indigo
  "#ff375f", // System pink
  "#34c759", // System green
  "#a2845e", // System brown
  "#8e8e93", // Neutral gray ("Other")
] as const;

export function readChartThemePalette(): ChartThemePalette {
  if (typeof window === "undefined") {
    return LIGHT_FALLBACK_PALETTE;
  }
  const styles = window.getComputedStyle(document.documentElement);
  return {
    ink: styles.getPropertyValue("--ink").trim() || LIGHT_FALLBACK_PALETTE.ink,
    ink2: styles.getPropertyValue("--ink-2").trim() || LIGHT_FALLBACK_PALETTE.ink2,
    ink3: styles.getPropertyValue("--ink-3").trim() || LIGHT_FALLBACK_PALETTE.ink3,
    line: styles.getPropertyValue("--line").trim() || LIGHT_FALLBACK_PALETTE.line,
    accent:
      styles.getPropertyValue("--accent").trim() ||
      LIGHT_FALLBACK_PALETTE.accent,
    gain: styles.getPropertyValue("--gain").trim() || LIGHT_FALLBACK_PALETTE.gain,
    loss: styles.getPropertyValue("--loss").trim() || LIGHT_FALLBACK_PALETTE.loss,
    surface:
      styles.getPropertyValue("--surface").trim() ||
      LIGHT_FALLBACK_PALETTE.surface,
    surface2:
      styles.getPropertyValue("--surface-2").trim() ||
      LIGHT_FALLBACK_PALETTE.surface2,
  };
}

/**
 * Returns a reactive CSS custom-property theme tick and resolved palette that
 * stays synchronized whenever `data-theme`, `data-gain-scheme`, or OS color
 * scheme changes.
 */
export function useChartThemePalette(): {
  palette: ChartThemePalette;
  themeTick: number;
} {
  const [themeTick, setThemeTick] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const bump = () => setThemeTick((t) => t + 1);

    const observer = new MutationObserver(bump);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-gain-scheme"],
    });

    const mql = window.matchMedia?.("(prefers-color-scheme: dark)");
    mql?.addEventListener?.("change", bump);

    return () => {
      observer.disconnect();
      mql?.removeEventListener?.("change", bump);
    };
  }, []);

  const palette = useMemo(() => {
    void themeTick;
    return typeof window !== "undefined"
      ? readChartThemePalette()
      : LIGHT_FALLBACK_PALETTE;
  }, [themeTick]);
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
  return `rgba(0, 113, 227, ${alpha})`;
}

/** Filters daily `{ date, ... }` arrays by standard chart horizon windows. */
export type AnalyticsChartRange =
  | "1M"
  | "3M"
  | "6M"
  | "YTD"
  | "1Y"
  | "5Y"
  | "MAX";

export const ANALYTICS_RANGE_OPTIONS: readonly AnalyticsChartRange[] = [
  "1M",
  "3M",
  "6M",
  "YTD",
  "1Y",
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
    case "5Y":
      cutoff = new Date(Date.UTC(y - 5, m - 1, d)).toISOString().slice(0, 10);
      break;
  }

  const sliced = points.filter((p) => p.date >= cutoff);
  return sliced.length >= 2 ? sliced : [...points];
}
