/**
 * Canonical brand identity and vector geometry for Kestrel.
 *
 * Kept dependency-free so both React UI components and Next.js `ImageResponse`
 * icon generators (`app/icon.tsx`, `app/apple-icon.tsx`) share the exact same
 * mark without duplicating coordinates or colours.
 */
export const APP_NAME = "Kestrel";
export const APP_FULL_NAME = "Kestrel · Portfolio Tracker";
export const APP_DESCRIPTION = "A personal stock and portfolio tracker.";

export const BRAND_PALETTE = {
  background: "#0E1117",
  border: "#262D38",
  accent: "#5B8DEF",
  ink: "#E8ECF1",
  gain: "#22C55E",
} as const;

export const BRAND_MARK_GEOMETRY = {
  viewBox: "0 0 64 64",
  areaPath: "M19 45 L30 33 L39 37 L46 19 L46 45 Z",
  stemPath: "M19 19 V45",
  trajectoryPath: "M25 33 L46 19",
  lowerWingPath: "M31 29 L45 45",
  apexNode: { cx: 46, cy: 19, r: 4.2 },
} as const;

