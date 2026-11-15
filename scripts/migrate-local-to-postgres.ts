/**
 * Copies Folio's local PGlite database (.data/pglite) into hosted Postgres
 * (such as Neon) and verifies row counts across every table.
 *
 * Usage:
 *   npm run db:copy-to-postgres
 *   npm run db:copy-to-postgres -- --replace
 *   npm run db:copy-to-postgres -- --verify-only
 *   npm run db:copy-to-postgres -- --skip-market-cache
 *
 * Reads DATABASE_URL from .env.local / environment without requiring auth secrets.
 */
import { existsSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { migrate as migratePostgres } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { Pool } from "pg";
import {
  migrationsFolder,
  pgliteDataDirectory,
  type Database,
} from "../db/client";
import {
  TABLE_KEYS,
  copyDatabaseContents,
  getDatabaseCounts,
  normalizeDatabaseUrlInput,
  redactPostgresUrl,
} from "../db/copy-local-to-postgres";
import * as schema from "../db/schema";

interface CliFlags {
  replace: boolean;
  skipMarketCache: boolean;
  verifyOnly: boolean;
  help: boolean;
}

function parseFlags(argv: readonly string[]): CliFlags {
  const known = new Set([
    "--replace",
    "--skip-market-cache",
    "--verify-only",
    "--help",
    "-h",
  ]);

  for (const arg of argv) {
    if (!known.has(arg)) {
      throw new Error(`Unknown option: ${arg}. Run with --help to see supported flags.`);
    }
  }

  return {
    replace: argv.includes("--replace"),
    skipMarketCache: argv.includes("--skip-market-cache"),
    verifyOnly: argv.includes("--verify-only"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

function printHelp(): void {
  console.log(`Copy local Folio database (.data/pglite) to Neon / hosted Postgres

Usage:
  npm run db:copy-to-postgres [options]

Options:
  --replace            Overwrite non-empty target tables atomically
  --skip-market-cache  Skip cached price_bar and fx_rate rows
  --verify-only        Compare row counts without writing changes
  -h, --help           Show this help message
`);
}

function printCountSummary(
  rows: Array<{ table: string; source: number; target: number; status: string }>,
): void {
  const width = 22;
  console.log(
    `${"Table".padEnd(width)} ${"Local".padStart(8)} ${"Neon".padStart(8)}  Status`,
  );
  console.log("-".repeat(52));
  for (const row of rows) {
    console.log(
      `${row.table.padEnd(width)} ${String(row.source).padStart(8)} ${String(row.target).padStart(8)}  ${row.status}`,
    );
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    return;
  }

  if (!existsSync(pgliteDataDirectory)) {
    throw new Error(
      `Local database directory not found at ${pgliteDataDirectory}. Nothing to migrate.`,
    );
  }

  const connectionString = normalizeDatabaseUrlInput(process.env.DATABASE_URL);
  const info = redactPostgresUrl(connectionString);

  console.log(`Source: local PGlite (${pgliteDataDirectory})`);
  console.log(`Target: ${info.display}`);
  if (info.isNeon && !info.isPooled) {
    console.log(
      "Note: Host does not contain '-pooler'. Neon's pooled connection string is recommended for Next.js / Vercel.",
    );
  }

  const sourceClient = new PGlite(pgliteDataDirectory);
  const targetPool = new Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
  });
  targetPool.on("error", (error) => {
    console.error("Postgres pool idle client error:", error.message);
  });

  try {
    const sourceDb = drizzlePglite(sourceClient, { schema }) as unknown as Database;
    const targetDb = drizzleNodePostgres(targetPool, { schema }) as unknown as Database;

    if (flags.verifyOnly) {
      const [sourceCounts, targetCounts] = await Promise.all([
        getDatabaseCounts(sourceDb),
        getDatabaseCounts(targetDb),
      ]);

      let allMatch = true;
      const summaryRows = TABLE_KEYS.map((table) => {
        const source = sourceCounts[table];
        const target = targetCounts[table];
        const matches = table === "login_attempt" ? target >= source : target === source;
        if (!matches) {
          allMatch = false;
        }
        return {
          table,
          source,
          target,
          status: matches ? "OK" : "MISMATCH",
        };
      });

      printCountSummary(summaryRows);
      if (!allMatch) {
        process.exitCode = 1;
        console.error("\nVerification failed: one or more tables differ.");
      } else {
        console.log("\nVerification passed: Neon matches local data.");
      }
      return;
    }

    const startedAt = Date.now();
    console.log("\n1/2 Applying schema migrations to target Postgres...");
    await migratePostgres(targetDb as Parameters<typeof migratePostgres>[0], {
      migrationsFolder,
    });

    console.log("2/2 Copying data and verifying row counts...");
    const result = await copyDatabaseContents(sourceDb, targetDb, {
      replace: flags.replace,
      skipMarketCache: flags.skipMarketCache,
    });

    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log("");
    printCountSummary(
      result.tables.map((row) => ({
        table: row.table,
        source: row.sourceCount,
        target: row.targetCount,
        status: "VERIFIED",
      })),
    );
    console.log(`\nMigration complete and verified in ${elapsedSeconds}s.`);
  } finally {
    await Promise.allSettled([sourceClient.close(), targetPool.end()]);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nMigration aborted: ${message}`);
  process.exit(1);
});

