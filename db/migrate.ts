/**
 * Applies SQLite / libSQL migrations from `db/migrations-sqlite`.
 *
 * Usage:
 *   npm run db:migrate
 *
 * With `TURSO_DATABASE_URL` set (production / staging) this migrates your
 * hosted Turso database. Without it, this migrates the local SQLite database
 * in `.data/kestrel.db`.
 *
 * It reads Turso variables straight from the process environment (loaded from
 * `.env.local` by the npm script) so it does not require password-gate vars.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

const migrationsFolder = path.join(process.cwd(), "db", "migrations-sqlite");

async function main(): Promise<void> {
  const tursoUrl = process.env.TURSO_DATABASE_URL?.trim();
  const tursoAuthToken = process.env.TURSO_AUTH_TOKEN?.trim() || undefined;

  let url: string;
  if (tursoUrl) {
    console.log("Migrating hosted Turso database (TURSO_DATABASE_URL)...");
    url = tursoUrl;
  } else {
    const dataFile = path.join(process.cwd(), ".data", "kestrel.db");
    await mkdir(path.dirname(dataFile), { recursive: true });
    console.log(
      "TURSO_DATABASE_URL not set: migrating local SQLite (.data/kestrel.db)...",
    );
    url = `file:${dataFile}`;
  }

  const client = createClient({
    url,
    authToken: tursoUrl ? tursoAuthToken : undefined,
  });

  try {
    await client.execute("PRAGMA foreign_keys = ON;");
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    client.close();
  }

  console.log("Migrations applied.");
}

main().catch((error: unknown) => {
  console.error(
    "Migration failed:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
