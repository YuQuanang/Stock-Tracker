import { describe, expect, it, vi } from "vitest";

// Environment must be set BEFORE the modules under test read it. vi.hoisted
// runs ahead of the (hoisted) imports below.
vi.hoisted(() => {
  process.env.APP_PASSWORD = "correct horse battery staple";
  process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef-test-secret";
});

import { NextRequest } from "next/server";
import { hashPassword, verifyPasswordHash, constantTimeStringEqual } from "@/lib/auth/password";
import { createSessionToken, verifySessionToken, SESSION_DURATION_SECONDS } from "@/lib/auth/session";
import { getSafeNextPath } from "@/lib/auth/safe-next";
import { sanitizeTrimmedEnvValue } from "@/lib/env";
import { isSameOriginRequest } from "@/proxy";

describe("password hashing", () => {
  it("accepts the right password and rejects a wrong one", async () => {
    const hash = await hashPassword("my-secret-pass");
    expect(await verifyPasswordHash("my-secret-pass", hash)).toBe(true);
    expect(await verifyPasswordHash("my-secret-pasS", hash)).toBe(false);
  });

  it("produces a different hash each time (random salt)", async () => {
    const first = await hashPassword("same-password");
    const second = await hashPassword("same-password");
    expect(first).not.toEqual(second);
  });

  it("contains no '$' characters, which .env loaders would expand", async () => {
    const hash = await hashPassword("anything-long-enough");
    expect(hash.includes("$")).toBe(false);
  });

  it("rejects malformed hashes instead of throwing", async () => {
    expect(await verifyPasswordHash("x", "not-a-hash")).toBe(false);
    expect(await verifyPasswordHash("x", "scrypt:1:2:3:abc")).toBe(false);
  });

  it("compares plain strings in constant time without length leaks", () => {
    expect(constantTimeStringEqual("abc", "abc")).toBe(true);
    expect(constantTimeStringEqual("abc", "abcd")).toBe(false);
  });
});

describe("session tokens", () => {
  it("verifies a freshly created token", () => {
    expect(verifySessionToken(createSessionToken())).toBe(true);
  });

  it("rejects missing or empty tokens", () => {
    expect(verifySessionToken(undefined)).toBe(false);
    expect(verifySessionToken("")).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const token = createSessionToken();
    const [payload, signature] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ exp: 9_999_999_999, ver: "forged" }),
    ).toString("base64url");
    expect(payload).not.toEqual(forgedPayload);
    expect(verifySessionToken(`${forgedPayload}.${signature}`)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const token = createSessionToken();
    expect(verifySessionToken(`${token}x`)).toBe(false);
  });

  it("expires after the session duration and on the next Singapore calendar day", () => {
    const issuedAt = new Date("2026-11-07T00:00:00+08:00").getTime();
    const token = createSessionToken(issuedAt);
    const justBeforeExpiry = issuedAt + (SESSION_DURATION_SECONDS - 5) * 1000;
    const justAfterExpiry = issuedAt + (SESSION_DURATION_SECONDS + 5) * 1000;
    expect(verifySessionToken(token, justBeforeExpiry)).toBe(true);
    expect(verifySessionToken(token, justAfterExpiry)).toBe(false);

    // A login at 10pm SGT stays valid through 11:59pm SGT that same day,
    // and requires logging in again on the next day at 8am SGT.
    const lateEvening = new Date("2026-11-07T22:00:00+08:00").getTime();
    const eveningToken = createSessionToken(lateEvening);
    expect(
      verifySessionToken(
        eveningToken,
        new Date("2026-11-07T23:59:00+08:00").getTime(),
      ),
    ).toBe(true);
    expect(
      verifySessionToken(
        eveningToken,
        new Date("2026-11-08T08:00:00+08:00").getTime(),
      ),
    ).toBe(false);
  });
});

describe("getSafeNextPath", () => {
  it("allows ordinary in-app paths", () => {
    expect(getSafeNextPath("/holdings")).toBe("/holdings");
    expect(getSafeNextPath("/transactions?type=Buy")).toBe("/transactions?type=Buy");
  });

  it("blocks open-redirect attempts", () => {
    expect(getSafeNextPath("https://evil.example")).toBe("/dashboard");
    expect(getSafeNextPath("//evil.example")).toBe("/dashboard");
    expect(getSafeNextPath("/\\evil.example")).toBe("/dashboard");
  });

  it("falls back for missing values and the login page itself", () => {
    expect(getSafeNextPath(null)).toBe("/dashboard");
    expect(getSafeNextPath(undefined)).toBe("/dashboard");
    expect(getSafeNextPath("/login")).toBe("/dashboard");
  });
});

describe("isSameOriginRequest and env sanitization", () => {
  it("accepts matching hosts behind Netlify forwarded headers", () => {
    const netlifyRequest = new NextRequest("https://internal.lambda/api/auth/login", {
      method: "POST",
      headers: {
        origin: "https://kestrel-demo.netlify.app",
        "x-forwarded-host": "kestrel-demo.netlify.app:443, edge-node",
        host: "internal.lambda",
      },
    });
    expect(isSameOriginRequest(netlifyRequest)).toBe(true);

    const emptyForwardedRequest = new NextRequest("https://kestrel-demo.netlify.app/api/auth/login", {
      method: "POST",
      headers: {
        origin: "https://kestrel-demo.netlify.app",
        "x-forwarded-host": "",
        host: "kestrel-demo.netlify.app",
      },
    });
    expect(isSameOriginRequest(emptyForwardedRequest)).toBe(true);
  });

  it("blocks cross-site or originless POST requests", () => {
    const evilRequest = new NextRequest("https://kestrel-demo.netlify.app/api/auth/login", {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        host: "kestrel-demo.netlify.app",
      },
    });
    expect(isSameOriginRequest(evilRequest)).toBe(false);

    const noOriginRequest = new NextRequest("https://kestrel-demo.netlify.app/api/auth/login", {
      method: "POST",
      headers: { host: "kestrel-demo.netlify.app" },
    });
    expect(isSameOriginRequest(noOriginRequest)).toBe(false);
  });

  it("trims whitespace and surrounding quotes from pasted env variables", () => {
    expect(sanitizeTrimmedEnvValue('  "libsql://kestrel-test.turso.io"  ')).toBe(
      "libsql://kestrel-test.turso.io",
    );
    expect(sanitizeTrimmedEnvValue("  my-session-secret-0123456789abcdef012345  ")).toBe(
      "my-session-secret-0123456789abcdef012345",
    );
    expect(sanitizeTrimmedEnvValue("   ")).toBeUndefined();
  });
});

