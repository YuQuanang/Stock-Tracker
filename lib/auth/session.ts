/**
 * Session tokens for the single-user gate.
 *
 * A token is `<payload>.<signature>` where:
 *   payload   = base64url(JSON { exp, ver })
 *   signature = base64url(HMAC-SHA256(payload, SESSION_SECRET))
 *
 * `ver` is a fingerprint of the configured password. Changing the password
 * therefore invalidates every existing session automatically.
 *
 * This file has no database access so it can be used from proxy.ts as well
 * as from route handlers.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/env";

/** Sessions last 1 day (24 hours) and expire each new Singapore calendar day. */
export const SESSION_DURATION_SECONDS = 60 * 60 * 24;

function getSingaporeCalendarDay(nowMilliseconds: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMilliseconds));
}

const DEVELOPMENT_ONLY_SECRET =
  "folio-development-only-secret-do-not-use-in-production-0123456789";

/**
 * The `__Host-` prefix makes browsers require Secure, Path=/ and no Domain,
 * which stops sibling subdomains from overwriting the cookie. It needs HTTPS,
 * so plain http://localhost development uses an unprefixed name.
 */
export function getSessionCookieName(): string {
  return getEnv().NODE_ENV === "production" ? "__Host-folio_session" : "folio_session";
}

function getSigningSecret(): string {
  const configured = getEnv().SESSION_SECRET;
  if (configured !== undefined) {
    return configured;
  }
  // env validation already forbids a missing secret in production.
  return DEVELOPMENT_ONLY_SECRET;
}

/** Short fingerprint of the configured password material (never the password). */
function getPasswordVersion(): string {
  const env = getEnv();
  const material = env.APP_PASSWORD_HASH ?? env.APP_PASSWORD ?? "";
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

function sign(payload: string): Buffer {
  return createHmac("sha256", getSigningSecret()).update(payload).digest();
}

interface SessionPayload {
  exp: number; // expiry, seconds since the Unix epoch
  day: string; // YYYY-MM-DD in Asia/Singapore so user logs in once each day
  ver: string; // password fingerprint
}

export function createSessionToken(nowMilliseconds: number = Date.now()): string {
  const payload: SessionPayload = {
    exp: Math.floor(nowMilliseconds / 1000) + SESSION_DURATION_SECONDS,
    day: getSingaporeCalendarDay(nowMilliseconds),
    ver: getPasswordVersion(),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(encodedPayload).toString("base64url");
  return `${encodedPayload}.${signature}`;
}

/** Returns true only for an untampered, unexpired token for the current day and password. */
export function verifySessionToken(
  token: string | undefined,
  nowMilliseconds: number = Date.now(),
): boolean {
  if (token === undefined || token === "") {
    return false;
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return false;
  }
  const [encodedPayload, encodedSignature] = parts;

  const providedSignature = Buffer.from(encodedSignature, "base64url");
  const expectedSignature = sign(encodedPayload);
  const signatureMatches =
    providedSignature.length === expectedSignature.length &&
    timingSafeEqual(providedSignature, expectedSignature);
  if (!signatureMatches) {
    return false;
  }

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return false;
  }

  const isNotExpired =
    typeof payload.exp === "number" && payload.exp > Math.floor(nowMilliseconds / 1000);
  const isSameDay =
    typeof payload.day === "string" &&
    payload.day === getSingaporeCalendarDay(nowMilliseconds);
  const passwordUnchanged = payload.ver === getPasswordVersion();
  return isNotExpired && isSameDay && passwordUnchanged;
}

/** Cookie attributes shared by login (set) and logout (clear). */
export function getSessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: getEnv().NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

