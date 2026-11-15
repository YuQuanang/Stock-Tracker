import { z } from "zod";

/**
 * Server-side environment variables, validated once with Zod.
 *
 * Why lazy (a function) instead of a top-level constant: `next build` imports
 * route modules without runtime secrets, so validating at import time would
 * break the build. We validate on first use at request time instead.
 *
 * Never import this file from a client component. These values are secrets.
 */

/**
 * Treat empty strings (e.g. a bare `DATABASE_URL=` line in .env) as "not set".
 */
function emptyStringToUndefined(value: unknown): unknown {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }
  return value;
}

/**
 * Trim whitespace and optional matching surrounding quotes from pasted tokens / URLs.
 */
export function sanitizeTrimmedEnvValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const unquoted = trimmed.slice(1, -1).trim();
    return unquoted === "" ? undefined : unquoted;
  }
  return trimmed;
}

const optionalString = z.preprocess(emptyStringToUndefined, z.string().optional());
const optionalSanitizedString = z.preprocess(
  sanitizeTrimmedEnvValue,
  z.string().optional(),
);

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    // Postgres connection string. When absent in development we fall back to
    // an embedded PGlite database stored under .data/pglite.
    DATABASE_URL: optionalSanitizedString,

    // Single-user password gate. Provide EITHER a scrypt hash (preferred,
    // generate with `npm run hash-password`) OR a plain password for quick
    // local use.
    APP_PASSWORD_HASH: optionalSanitizedString,
    APP_PASSWORD: optionalString,

    // Secret used to sign the session cookie (>= 32 characters).
    SESSION_SECRET: optionalSanitizedString,

    // Optional provider keys (used from Milestone 4 onwards).
    FINNHUB_API_KEY: optionalSanitizedString,
  })
  .superRefine((env, context) => {
    const hasHash = env.APP_PASSWORD_HASH !== undefined;
    const hasPlain = env.APP_PASSWORD !== undefined;

    if (!hasHash && !hasPlain) {
      context.addIssue({
        code: "custom",
        path: ["APP_PASSWORD_HASH"],
        message:
          "Set APP_PASSWORD_HASH (recommended) or APP_PASSWORD to enable sign-in.",
      });
    }

    if (env.SESSION_SECRET !== undefined && env.SESSION_SECRET.length < 32) {
      context.addIssue({
        code: "custom",
        path: ["SESSION_SECRET"],
        message: "SESSION_SECRET must be at least 32 characters long.",
      });
    }

    if (env.NODE_ENV === "production") {
      if (env.SESSION_SECRET === undefined) {
        context.addIssue({
          code: "custom",
          path: ["SESSION_SECRET"],
          message: "SESSION_SECRET is required in production.",
        });
      }
      if (env.DATABASE_URL === undefined) {
        context.addIssue({
          code: "custom",
          path: ["DATABASE_URL"],
          message:
            "DATABASE_URL is required in production (PGlite is for local development only).",
        });
      }
    }
  });

export type ServerEnv = z.infer<typeof envSchema>;

let cachedEnv: ServerEnv | undefined;

/**
 * Returns the validated environment, or throws an Error whose message lists
 * every problem in plain English (without echoing any secret values).
 */
export function getEnv(): ServerEnv {
  if (cachedEnv !== undefined) {
    return cachedEnv;
  }

  const parsed = envSchema.safeParse({
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    APP_PASSWORD_HASH: process.env.APP_PASSWORD_HASH,
    APP_PASSWORD: process.env.APP_PASSWORD,
    SESSION_SECRET: process.env.SESSION_SECRET,
    FINNHUB_API_KEY: process.env.FINNHUB_API_KEY,
  });

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  cachedEnv = parsed.data;
  return cachedEnv;
}

