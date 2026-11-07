/**
 * Applies SQL migrations from db/migrations.
 *
 * Usage:
 *   npm run db:migrate
 *
 * With DATABASE_URL set (production) this migrates your hosted Postgres.
 * Without it, this migrates the local PGlite database in .data/pglite.
 *
 * It reads DATABASE_URL straight from the process environment (loaded from
 * .env.local by the npm script) so it does not require the password gate
 * variables to be present.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";

const migrationsFolder = path.join(process.cwd(), "db", "migrations");

async function migratePostgres(connectionString: string): Promise<void> {
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");

  const pool = new Pool({ connectionString, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}

async function migratePglite(): Promise<void> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");

  const dataDirectory = path.join(process.cwd(), ".data", "pglite");
  await mkdir(path.dirname(dataDirectory), { recursive: true });

  const client = new PGlite(dataDirectory);
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();

  if (connectionString) {
    console.log("Migrating hosted Postgres (DATABASE_URL)...");
    await migratePostgres(connectionString);
  } else {
    console.log("DATABASE_URL not set: migrating local PGlite (.data/pglite)...");
    await migratePglite();
  }

  console.log("Migrations applied.");
}

main().catch((error: unknown) => {
  console.error("Migration failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
