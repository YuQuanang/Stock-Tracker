import { describe, expect, it, vi } from "vitest";

// Environment must be set BEFORE the modules under test read it. vi.hoisted
// runs ahead of the (hoisted) imports below.
vi.hoisted(() => {
  process.env.APP_PASSWORD = "correct horse battery staple";
  process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef-test-secret";
});

import { hashPassword, verifyPasswordHash, constantTimeStringEqual } from "@/lib/auth/password";
import { createSessionToken, verifySessionToken, SESSION_DURATION_SECONDS } from "@/lib/auth/session";
import { getSafeNextPath } from "@/lib/auth/safe-next";

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

  it("expires after the session duration", () => {
    const issuedAt = Date.UTC(2026, 10, 7);
    const token = createSessionToken(issuedAt);
    const justBeforeExpiry = issuedAt + (SESSION_DURATION_SECONDS - 5) * 1000;
    const justAfterExpiry = issuedAt + (SESSION_DURATION_SECONDS + 5) * 1000;
    expect(verifySessionToken(token, justBeforeExpiry)).toBe(true);
    expect(verifySessionToken(token, justAfterExpiry)).toBe(false);
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

