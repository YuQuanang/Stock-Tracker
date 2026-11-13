import { ImageResponse } from "next/og";

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
          background: "linear-gradient(155deg, #1a1d24 0%, #0b0d12 100%)",
        }}
      >
        <svg
          width="180"
          height="180"
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
            strokeWidth="32"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="396" cy="154" r="26" fill="#34c759" />
          <circle cx="396" cy="154" r="11" fill="#ffffff" />
        </svg>
      </div>
    ),
    {
      ...size,
    },
  );
}

