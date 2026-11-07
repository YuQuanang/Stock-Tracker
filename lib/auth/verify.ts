/**
 * Checks a submitted password against the configured one.
 * Prefers APP_PASSWORD_HASH; falls back to the plain APP_PASSWORD.
 */
import { getEnv } from "@/lib/env";
import { constantTimeStringEqual, verifyPasswordHash } from "@/lib/auth/password";

export async function verifyAppPassword(candidate: string): Promise<boolean> {
  const env = getEnv();

  if (env.APP_PASSWORD_HASH !== undefined) {
    return verifyPasswordHash(candidate, env.APP_PASSWORD_HASH);
  }

  if (env.APP_PASSWORD !== undefined) {
    return constantTimeStringEqual(candidate, env.APP_PASSWORD);
  }

  // Unreachable in practice: env validation requires one of the two.
  return false;
}

