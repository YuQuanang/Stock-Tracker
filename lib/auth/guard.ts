/**
 * Defence-in-depth guard for Route Handlers.
 *
 * proxy.ts already blocks unauthenticated requests, but the Next.js docs warn
 * that a proxy matcher change can silently remove coverage. Every handler
 * therefore calls requireSession() itself:
 *
 *   export async function GET(request: NextRequest) {
 *     const denied = requireSession(request);
 *     if (denied) return denied;
 *     ...
 *   }
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSessionCookieName, verifySessionToken } from "@/lib/auth/session";

export function isAuthenticated(request: NextRequest): boolean {
  const token = request.cookies.get(getSessionCookieName())?.value;
  return verifySessionToken(token);
}

/** Returns a 401 response when not signed in, otherwise null. */
export function requireSession(request: NextRequest): NextResponse | null {
  if (isAuthenticated(request)) {
    return null;
  }
  return NextResponse.json({ error: "Please sign in to continue." }, { status: 401 });
}

