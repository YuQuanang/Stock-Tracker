import { ImageResponse } from "next/og";
import { BRAND_MARK_GEOMETRY, BRAND_PALETTE } from "@/lib/brand";

export function generateImageMetadata() {
  return [
    {
      contentType: "image/png",
      size: { width: 192, height: 192 },
      id: "192",
    },
    {
      contentType: "image/png",
      size: { width: 512, height: 512 },
      id: "512",
    },
  ];
}

export default async function Icon({
  id,
}: {
  id: Promise<string | number>;
}) {
  const resolvedId = String(await id);
  const size = resolvedId === "192" ? 192 : 512;
  const radius = Math.round(size * 0.22);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: radius,
          background: BRAND_PALETTE.background,
          border: `${Math.max(2, Math.round(size * 0.03))}px solid ${BRAND_PALETTE.border}`,
        }}
      >
        <svg
          width={size}
          height={size}
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
      width: size,
      height: size,
    },
  );
}
