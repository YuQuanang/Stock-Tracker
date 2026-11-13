import { ImageResponse } from "next/og";

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
          background: "linear-gradient(155deg, #1a1d24 0%, #0b0d12 100%)",
        }}
      >
        <svg
          width={size}
          height={size}
          viewBox="0 0 512 512"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M116 338 L194 268 L254 294 L334 196 L396 154 L396 364 L116 364 Z"
            fill="rgba(10, 132, 255, 0.18)"
          />
          <path
            d="M116 338 L194 268 L254 294 L334 196 L396 154"
            stroke="#0a84ff"
            strokeWidth="30"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="396" cy="154" r="24" fill="#34c759" />
          <circle cx="396" cy="154" r="10" fill="#ffffff" />
        </svg>
      </div>
    ),
    {
      width: size,
      height: size,
    },
  );
}

