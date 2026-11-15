import { BRAND_MARK_GEOMETRY, BRAND_PALETTE } from "@/lib/brand";

interface BrandLogoProps {
  /** Square pixel dimension for the logo mark. Defaults to 28px. */
  size?: number;
  /** Thicker stroke profile helps tiny 16px–20px tab/header renders stay crisp. */
  denseStroke?: boolean;
  className?: string;
}

/** Minimal geometric Kestrel logo mark matching the Dark Graphite Terminal palette. */
export function BrandLogo({
  size = 28,
  denseStroke = false,
  className,
}: BrandLogoProps) {
  const strokeWidth = denseStroke ? 5.6 : 5.2;

  return (
    <svg
      width={size}
      height={size}
      viewBox={BRAND_MARK_GEOMETRY.viewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={className}
    >
      <rect
        x="2"
        y="2"
        width="60"
        height="60"
        rx="14"
        fill={BRAND_PALETTE.background}
        stroke={BRAND_PALETTE.border}
        strokeWidth="2"
      />
      <path
        d={BRAND_MARK_GEOMETRY.areaPath}
        fill={BRAND_PALETTE.accent}
        fillOpacity="0.14"
      />
      <path
        d={BRAND_MARK_GEOMETRY.stemPath}
        stroke={BRAND_PALETTE.ink}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <path
        d={BRAND_MARK_GEOMETRY.trajectoryPath}
        stroke={BRAND_PALETTE.accent}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <path
        d={BRAND_MARK_GEOMETRY.lowerWingPath}
        stroke={BRAND_PALETTE.ink}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <circle
        cx={BRAND_MARK_GEOMETRY.apexNode.cx}
        cy={BRAND_MARK_GEOMETRY.apexNode.cy}
        r={BRAND_MARK_GEOMETRY.apexNode.r}
        fill={BRAND_PALETTE.gain}
      />
    </svg>
  );
}

