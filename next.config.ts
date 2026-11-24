import type { NextConfig } from "next";

const isDevelopment = process.env.NODE_ENV !== "production";

/**
 * Content-Security-Policy.
 *
 * Next.js injects small inline scripts for hydration, so 'unsafe-inline' is
 * required for scripts unless we move to per-request nonces. This is an
 * accepted trade-off for a single-user app: the policy still blocks framing,
 * third-party scripts, and any connection other than our own origin.
 * React's development tooling needs 'unsafe-eval', so it is dev-only.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
];

const nextConfig: NextConfig = {
  // Keep @libsql/client external so native/runtime bindings are not bundled.
  serverExternalPackages: ["@libsql/client"],

  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
