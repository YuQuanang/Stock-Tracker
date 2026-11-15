"use client";

interface SparklineProps {
  values: readonly (string | number)[];
  width?: number;
  height?: number;
  tone?: "gain-loss" | "accent";
  className?: string;
}

/**
 * Crisp flat SVG sparkline for hero stats, holdings, and watchlist rows.
 * Never renders gradient fills under data.
 */
export function Sparkline({
  values,
  width = 88,
  height = 30,
  tone = "gain-loss",
  className = "",
}: SparklineProps) {
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
    tone === "accent"
      ? "var(--accent)"
      : last > first
        ? "var(--gain)"
        : last < first
          ? "var(--loss)"
          : "var(--ink-2)";

  const polylinePoints = coords
    .map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
    .join(" ");

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      className={`shrink-0 overflow-visible ${className}`}
    >
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
