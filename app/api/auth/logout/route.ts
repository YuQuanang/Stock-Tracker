import { NextResponse } from "next/server";
import { getSessionCookieName, getSessionCookieOptions } from "@/lib/auth/session";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  // maxAge 0 tells the browser to delete the cookie immediately.
  response.cookies.set(getSessionCookieName(), "", getSessionCookieOptions(0));
  return response;
}

