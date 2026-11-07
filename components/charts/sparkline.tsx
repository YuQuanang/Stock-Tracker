"use client";

import { useId } from "react";

interface SparklineProps {
  values: readonly (string | number)[];
  width?: number;
  height?: number;
  className?: string;
}

/**
 * Lightweight custom SVG sparkline for holdings and watchlist rows.
 *
 * Uses CSS variables (`var(--gain)`, `var(--loss)`, `var(--ink-3)`) so it
 * automatically adapts to Light/Dark mode and Red-Up / Colour-Blind-Safe
 * schemes without JavaScript theme listeners.
 */
export function Sparkline({
  values,
  width = 88,
  height = 30,
  className = "",
}: SparklineProps) {
  const gradientId = useId();

  const nums = values
    .map((v) => (typeof v === "number" ? v : Number(v)))
    .filter((n) => Number.isFinite(n));

  if (nums.length < 2) {
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden="true"
        className={`shrink-0 ${className}`}
      >
        <line
          x1={4}
          y1={height / 2}
          x2={width - 4}
          y2={height / 2}
          stroke="var(--line)"
          strokeWidth={1.5}
          strokeDasharray="3 3"
        />
      </svg>
    );
  }

  const minVal = Math.min(...nums);
  const maxVal = Math.max(...nums);
  const span = maxVal - minVal;

  const padX = 2;
  const padY = 3;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  const coords = nums.map((val, idx) => {
    const x = padX + (idx / (nums.length - 1)) * innerW;
    const y =
      span === 0
        ? height / 2
        : padY + innerH - ((val - minVal) / span) * innerH;
    return { x, y };
  });

  const first = nums[0];
  const last = nums[nums.length - 1];
  const strokeColor =
    last > first
      ? "var(--gain)"
      : last < first
        ? "var(--loss)"
        : "var(--ink-3)";

  const polylinePoints = coords
    .map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
    .join(" ");

  const firstPt = coords[0];
  const lastPt = coords[coords.length - 1];
  const areaPath = [
    `M ${firstPt.x.toFixed(1)} ${height - 1}`,
    ...coords.map((pt) => `L ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`),
    `L ${lastPt.x.toFixed(1)} ${height - 1}`,
    "Z",
  ].join(" ");

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      className={`shrink-0 overflow-visible ${className}`}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={strokeColor} stopOpacity={0.22} />
          <stop offset="100%" stopColor={strokeColor} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradientId})`} />
      <polyline
        fill="none"
        stroke={strokeColor}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        points={polylinePoints}
      />
    </svg>
  );
}

