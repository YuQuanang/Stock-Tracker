/**
 * Database client.
 *
 *  - Production / hosted: node-postgres against DATABASE_URL (Neon, Supabase).
 *  - Local development without DATABASE_URL: embedded PGlite in .data/pglite,
 *    with migrations applied automatically on first connect so there is zero
 *    setup.
 *
 * SERVER ONLY. The browser never talks to the database. Do not import this
 * from a client component.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import * as schema from "@/db/schema";
import { getEnv } from "@/lib/env";

// The two drivers expose different query-result types, but the query builder
// API we use is identical. `any` is confined to this single alias on purpose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Database = PgDatabase<any, typeof schema>;

export type DatabaseKind = "postgres" | "pglite";

const migrationsFolder = path.join(process.cwd(), "db", "migrations");
const pgliteDataDirectory = path.join(process.cwd(), ".data", "pglite");

/**
 * Keep one connection across hot reloads in development and across warm
 * invocations on serverless, so we do not open a new pool for every request.
 */
type GlobalWithDatabase = typeof globalThis & {
  __folioDatabase?: Promise<Database>;
};

const globalScope = globalThis as GlobalWithDatabase;

async function createPostgresDatabase(connectionString: string): Promise<Database> {
  // A tiny pool: serverless functions are short-lived, and hosted free tiers
  // have low connection limits. Use the provider's *pooled* connection string.
  const pool = new Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  return drizzleNodePostgres(pool, { schema });
}

async function createPgliteDatabase(): Promise<Database> {
  // Imported dynamically so production bundles never load the WASM database.
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");

  // PGlite creates its own folder but not the parent, so make sure it exists.
  await mkdir(path.dirname(pgliteDataDirectory), { recursive: true });

  const client = new PGlite(pgliteDataDirectory);
  const database = drizzle(client, { schema });

  // Local convenience: keep the dev database up to date automatically.
  await migrate(database, { migrationsFolder });
  return database;
}

export function getDatabaseKind(): DatabaseKind {
  return getEnv().DATABASE_URL === undefined ? "pglite" : "postgres";
}

export function getDb(): Promise<Database> {
  if (globalScope.__folioDatabase === undefined) {
    const connectionString = getEnv().DATABASE_URL;

    globalScope.__folioDatabase =
      connectionString === undefined
        ? createPgliteDatabase()
        : createPostgresDatabase(connectionString);

    // If connecting fails, forget the failed promise so the next request retries.
    globalScope.__folioDatabase.catch(() => {
      globalScope.__folioDatabase = undefined;
    });
  }
  return globalScope.__folioDatabase;
}
