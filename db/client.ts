/**
 * Database client (Turso / libSQL / SQLite).
 *
 *  - Production / hosted: `@libsql/client` against `TURSO_DATABASE_URL` +
 *    `TURSO_AUTH_TOKEN`.
 *  - Local development without `TURSO_DATABASE_URL`: local embedded libSQL
 *    SQLite file in `.data/kestrel.db`, with migrations applied automatically
 *    on first connect so there is zero setup.
 *
 * SERVER ONLY. The browser never talks to the database. Do not import this
 * from a client component.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import * as schema from "@/db/schema";
import { getEnv } from "@/lib/env";

export type Database = LibSQLDatabase<typeof schema>;

export type DatabaseKind = "turso" | "local-sqlite";

export const migrationsFolder = path.join(
  process.cwd(),
  "db",
  "migrations-sqlite",
);
export const localSqlitePath = path.join(process.cwd(), ".data", "kestrel.db");

/**
 * Keep one client across hot reloads in development and across warm
 * invocations on serverless.
 */
type GlobalWithDatabase = typeof globalThis & {
  __folioDatabase?: Promise<Database>;
};

const globalScope = globalThis as GlobalWithDatabase;

async function createTursoDatabase(
  url: string,
  authToken?: string,
): Promise<Database> {
  const client = createClient({
    url,
    authToken,
  });
  await client.execute("PRAGMA foreign_keys = ON;");
  return drizzle(client, { schema });
}

async function createLocalSqliteDatabase(): Promise<Database> {
  await mkdir(path.dirname(localSqlitePath), { recursive: true });

  const client = createClient({
    url: `file:${localSqlitePath}`,
  });
  await client.execute("PRAGMA foreign_keys = ON;");
  const database = drizzle(client, { schema });

  // Local convenience: keep the dev database up to date automatically.
  await migrate(database, { migrationsFolder });
  return database;
}

/**
 * Creates an isolated in-memory libSQL/SQLite database with foreign keys
 * enabled and all SQLite migrations applied. Intended for unit/integration tests.
 */
export async function createInMemoryTestDatabase(): Promise<Database> {
  const client = createClient({ url: ":memory:" });
  await client.execute("PRAGMA foreign_keys = ON;");
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder });
  return database;
}

export function getDatabaseKind(): DatabaseKind {
  return getEnv().TURSO_DATABASE_URL === undefined ? "local-sqlite" : "turso";
}

export function getDb(): Promise<Database> {
  if (globalScope.__folioDatabase === undefined) {
    const env = getEnv();
    const tursoUrl = env.TURSO_DATABASE_URL;

    globalScope.__folioDatabase =
      tursoUrl === undefined
        ? createLocalSqliteDatabase()
        : createTursoDatabase(tursoUrl, env.TURSO_AUTH_TOKEN);

    // If connecting fails, forget the failed promise so the next request retries.
    globalScope.__folioDatabase.catch(() => {
      globalScope.__folioDatabase = undefined;
    });
  }
  return globalScope.__folioDatabase;
}
