import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  createSessionToken,
  getSessionCookieName,
  getSessionCookieOptions,
  SESSION_DURATION_SECONDS,
} from "@/lib/auth/session";
import { verifyAppPassword } from "@/lib/auth/verify";
import { checkLoginAllowed, recordLoginAttempt } from "@/lib/auth/rate-limit";

const loginBodySchema = z.object({
  // Upper bound stops absurdly large inputs from burning CPU in scrypt.
  password: z.string().min(1).max(200),
});

/**
 * Identifies the caller for rate limiting. On Vercel, x-forwarded-for is set
 * by the platform; the first entry is the original client.
 */
function getClientKey(request: NextRequest): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor !== null) {
    return forwardedFor.split(",")[0].trim();
  }
  return request.headers.get("x-real-ip") ?? "unknown";
}

export async function POST(request: NextRequest) {
  const body = loginBodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: "Please enter your password." }, { status: 400 });
  }

  const clientKey = getClientKey(request);

  let decision;
  try {
    decision = await checkLoginAllowed(clientKey);
  } catch (error) {
    console.error(
      "Login rate-limit check failed:",
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json(
      {
        error:
          "Unable to reach the database. Check TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in your hosting environment variables and redeploy.",
      },
      { status: 503 },
    );
  }

  if (!decision.allowed) {
    const minutes = Math.ceil(decision.retryAfterSeconds / 60);
    return NextResponse.json(
      {
        error: `Too many incorrect attempts. Please try again in about ${minutes} minute${
          minutes === 1 ? "" : "s"
        }.`,
      },
      { status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds) } },
    );
  }

  let passwordIsCorrect: boolean;
  try {
    passwordIsCorrect = await verifyAppPassword(body.data.password);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Authentication configuration error.";
    return NextResponse.json({ error: message }, { status: 503 });
  }

  try {
    await recordLoginAttempt(clientKey, passwordIsCorrect);
  } catch (error) {
    console.error(
      "Failed to record login attempt:",
      error instanceof Error ? error.message : error,
    );
  }

  if (!passwordIsCorrect) {
    return NextResponse.json({ error: "That password is incorrect." }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(
    getSessionCookieName(),
    createSessionToken(),
    getSessionCookieOptions(SESSION_DURATION_SECONDS),
  );
  return response;
}

