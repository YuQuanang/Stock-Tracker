import { createElement } from "react";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeInitScript } from "@/components/theme-init-script";
import nextConfig from "@/next.config";

describe("Netlify headers, proxy redirects, and hydration-safe scripts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("omits deprecated interest-cohort from Permissions-Policy header", async () => {
    const headerRules = await nextConfig.headers?.();
    const globalRule = headerRules?.find((rule) => rule.source === "/:path*");
    const permissionsHeader = globalRule?.headers.find(
      (header) => header.key === "Permissions-Policy",
    );

    expect(permissionsHeader?.value).toBe("camera=(), microphone=(), geolocation=()");
  });

  it("renders ThemeInitScript as executable server script without needing a manual <head>", () => {
    const html = renderToStaticMarkup(createElement(ThemeInitScript));
    expect(html).toContain('type="text/javascript"');
    expect(html).toContain("data-gain-scheme");
  });

  it("sets no-cache headers and https protocol on auth redirects in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURSO_DATABASE_URL", "libsql://kestrel-test.turso.io");
    vi.stubEnv("TURSO_AUTH_TOKEN", "test-turso-auth-token");
    vi.stubEnv("SESSION_SECRET", "super-secret-signing-key-at-least-32-chars");
    vi.stubEnv("APP_PASSWORD", "test-password-2898");
    vi.resetModules();

    const { proxy } = await import("@/proxy");
    const { createSessionToken, getSessionCookieName } = await import("@/lib/auth/session");

    expect(getSessionCookieName()).toBe("__Host-folio_session");

    // 1. Unauthenticated /dashboard redirect upgrades to https and forbids CDN caching.
    const unauthRequest = new NextRequest("http://kestrel.netlify.app/dashboard", {
      headers: {
        host: "kestrel.netlify.app",
        "x-forwarded-proto": "https",
      },
    });
    const unauthResponse = proxy(unauthRequest);
    expect(unauthResponse.status).toBe(307);
    expect(unauthResponse.headers.get("location")).toBe(
      "https://kestrel.netlify.app/login?next=%2Fdashboard",
    );
    expect(unauthResponse.headers.get("cache-control")).toContain("no-store");
    expect(unauthResponse.headers.get("x-middleware-cache")).toBe("no-cache");
    expect(unauthResponse.headers.get("vary")).toBe("Cookie");

    // 2. Authenticated request to /login with __Host-folio_session goes to /dashboard.
    const authedLoginRequest = new NextRequest("http://kestrel.netlify.app/login", {
      headers: {
        host: "kestrel.netlify.app",
        "x-forwarded-proto": "https",
        cookie: `${getSessionCookieName()}=${createSessionToken()}`,
      },
    });
    const authedLoginResponse = proxy(authedLoginRequest);
    expect(authedLoginResponse.status).toBe(307);
    expect(authedLoginResponse.headers.get("location")).toBe(
      "https://kestrel.netlify.app/dashboard",
    );
    expect(authedLoginResponse.headers.get("cache-control")).toContain("no-store");
    expect(authedLoginResponse.headers.get("x-middleware-cache")).toBe("no-cache");
  });
});
