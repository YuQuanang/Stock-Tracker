import { ImageResponse } from "next/og";
import { BRAND_MARK_GEOMETRY, BRAND_PALETTE } from "@/lib/brand";

export const size = {
  width: 180,
  height: 180,
};

export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: BRAND_PALETTE.background,
        }}
      >
        <svg
          width="180"
          height="180"
          viewBox={BRAND_MARK_GEOMETRY.viewBox}
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d={BRAND_MARK_GEOMETRY.areaPath}
            fill="rgba(91, 141, 239, 0.16)"
          />
          <path
            d={BRAND_MARK_GEOMETRY.stemPath}
            stroke={BRAND_PALETTE.ink}
            strokeWidth="5.2"
            strokeLinecap="round"
          />
          <path
            d={BRAND_MARK_GEOMETRY.trajectoryPath}
            stroke={BRAND_PALETTE.accent}
            strokeWidth="5.2"
            strokeLinecap="round"
          />
          <path
            d={BRAND_MARK_GEOMETRY.lowerWingPath}
            stroke={BRAND_PALETTE.ink}
            strokeWidth="5.2"
            strokeLinecap="round"
          />
          <circle
            cx={BRAND_MARK_GEOMETRY.apexNode.cx}
            cy={BRAND_MARK_GEOMETRY.apexNode.cy}
            r={BRAND_MARK_GEOMETRY.apexNode.r}
            fill={BRAND_PALETTE.gain}
          />
        </svg>
      </div>
    ),
    {
      ...size,
    },
  );
}
