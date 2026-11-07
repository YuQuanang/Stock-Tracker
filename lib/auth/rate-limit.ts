/**
 * Login rate limiting, backed by the database.
 *
 * Serverless instances do not share memory, so an in-memory counter would let
 * an attacker reset it just by hitting a different instance. Storing attempts
 * in Postgres makes the limit reliable.
 *
 * Two independent limits apply:
 *   - per client IP:   5 failures in 15 minutes
 *   - global (all IPs): 20 failures in 15 minutes, because with one user, a
 *     sustained flood of failures from many addresses is an attack too.
 */
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { loginAttempt } from "@/db/schema";

const WINDOW_MINUTES = 15;
const MAX_FAILURES_PER_IP = 5;
const MAX_FAILURES_GLOBAL = 20;
const GLOBAL_KEY = "global";

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds the client should wait, when blocked. */
  retryAfterSeconds: number;
}

async function countRecentFailures(key: string): Promise<{ count: number; oldest: Date | null }> {
  const database = await getDb();
  const windowStart = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000);

  const rows = await database
    .select({
      count: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(${loginAttempt.attemptedAt})`,
    })
    .from(loginAttempt)
    .where(
      and(
        eq(loginAttempt.key, key),
        eq(loginAttempt.succeeded, false),
        gt(loginAttempt.attemptedAt, windowStart),
      ),
    );

  const row = rows[0];
  return {
    count: row?.count ?? 0,
    oldest: row?.oldest ? new Date(row.oldest) : null,
  };
}

function secondsUntilWindowFrees(oldest: Date | null): number {
  if (oldest === null) {
    return WINDOW_MINUTES * 60;
  }
  const freesAt = oldest.getTime() + WINDOW_MINUTES * 60 * 1000;
  return Math.max(1, Math.ceil((freesAt - Date.now()) / 1000));
}

/** Call BEFORE checking the password. */
export async function checkLoginAllowed(clientKey: string): Promise<RateLimitDecision> {
  const perClient = await countRecentFailures(clientKey);
  if (perClient.count >= MAX_FAILURES_PER_IP) {
    return { allowed: false, retryAfterSeconds: secondsUntilWindowFrees(perClient.oldest) };
  }

  const global = await countRecentFailures(GLOBAL_KEY);
  if (global.count >= MAX_FAILURES_GLOBAL) {
    return { allowed: false, retryAfterSeconds: secondsUntilWindowFrees(global.oldest) };
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

/** Call AFTER checking the password. */
export async function recordLoginAttempt(clientKey: string, succeeded: boolean): Promise<void> {
  const database = await getDb();

  if (succeeded) {
    // A correct password clears this client's failure history.
    await database.delete(loginAttempt).where(eq(loginAttempt.key, clientKey));
    return;
  }

  await database.insert(loginAttempt).values([
    { key: clientKey, succeeded: false },
    { key: GLOBAL_KEY, succeeded: false },
  ]);

  // Housekeeping: drop rows older than a day so the table stays tiny.
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await database.delete(loginAttempt).where(lt(loginAttempt.attemptedAt, cutoff));
}

