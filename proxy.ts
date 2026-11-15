/**
 * Proxy (formerly "middleware" before Next.js 16): the single front door.
 *
 *  1. Rejects cross-site state-changing requests (CSRF) by comparing the
 *     Origin header with the Host header.
 *  2. Requires a valid session cookie for every page and API route except the
 *     login page, the login/logout endpoints, and static assets.
 *
 * Pages redirect to /login; API calls get a 401 JSON response.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionCookieName, verifySessionToken } from "@/lib/auth/session";

const PUBLIC_PATHS = new Set(["/login", "/api/auth/login", "/api/auth/logout"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function normalizeHostHeader(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const first = value.split(",")[0]?.trim().toLowerCase() ?? "";
  if (first === "") {
    return null;
  }
  return first.replace(/:(80|443)$/, "");
}

export function isSameOriginRequest(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) {
    // Browsers always send Origin on cross-site POSTs. A missing Origin on a
    // state-changing request is not something our own UI produces.
    return false;
  }

  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase().replace(/:(80|443)$/, "");
  } catch {
    return false;
  }

  const candidateHosts = [
    normalizeHostHeader(request.headers.get("x-forwarded-host")),
    normalizeHostHeader(request.headers.get("host")),
    normalizeHostHeader(request.nextUrl.host),
  ].filter((candidate): candidate is string => candidate !== null);

  return candidateHosts.includes(originHost);
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApiRoute = pathname.startsWith("/api/");

  if (!SAFE_METHODS.has(request.method) && !isSameOriginRequest(request)) {
    return NextResponse.json(
      { error: "Cross-site request blocked." },
      { status: 403 },
    );
  }

  let hasValidSession: boolean;
  try {
    hasValidSession = verifySessionToken(
      request.cookies.get(getSessionCookieName())?.value,
    );
  } catch (error) {
    // Most likely a missing or invalid environment variable. Fail closed with
    // a clear message. Variable names are safe to show; values never are.
    const message = error instanceof Error ? error.message : "Server misconfigured.";
    return new NextResponse(`Kestrel is not configured.\n\n${message}\n`, {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (PUBLIC_PATHS.has(pathname)) {
    // A signed-in user opening /login goes straight to the app.
    if (pathname === "/login") {
      if (hasValidSession) {
        return redirectWithoutCache(request, new URL("/dashboard", request.url));
      }
      const response = NextResponse.next();
      response.headers.set("Cache-Control", "no-store, private");
      response.headers.set("Vary", "Cookie");
      return response;
    }
    return NextResponse.next();
  }

  if (hasValidSession) {
    return NextResponse.next();
  }

  if (isApiRoute) {
    return NextResponse.json({ error: "Please sign in to continue." }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.url);
  if (pathname !== "/") {
    loginUrl.searchParams.set("next", pathname + request.nextUrl.search);
  }
  return redirectWithoutCache(request, loginUrl);
}

/**
 * Returns an uncacheable redirect locked to HTTPS when forwarded over TLS so
 * edge CDNs (like Netlify) never serve stale auth redirects across sessions.
 */
function redirectWithoutCache(request: NextRequest, url: URL): NextResponse {
  const forwardedProto = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  if (forwardedProto === "https" && url.protocol === "http:") {
    url.protocol = "https:";
  }
  const response = NextResponse.redirect(url);
  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("x-middleware-cache", "no-cache");
  response.headers.set("Vary", "Cookie");
  return response;
}

export const config = {
  // Everything except Next.js internals, public static files, and PWA endpoints.
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|manifest\\.webmanifest|sw\\.js|apple-icon|icon(?:\\.svg|/|$)|icons/|robots\\.txt).*)",
  ],
};

