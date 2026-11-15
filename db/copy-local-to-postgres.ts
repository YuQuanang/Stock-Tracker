/**
 * Reusable, dependency-ordered PostgreSQL data transfer helpers for copying
 * Folio's local PGlite store (.data/pglite) to a hosted Postgres database
 * such as Neon without losing ledger history, settings, splits, or cached
 * historical prices/FX rates.
 */
import { sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Database } from "@/db/client";
import * as schema from "@/db/schema";

export const TABLE_KEYS = [
  "settings",
  "csv_import_log",
  "portfolio",
  "instrument",
  "portfolio_instrument",
  "transaction",
  "corporate_action",
  "price_bar",
  "fx_rate",
  "login_attempt",
] as const;

export type TableKey = (typeof TABLE_KEYS)[number];
export type DatabaseCounts = Record<TableKey, number>;

export interface CopyDatabaseOptions {
  /** Overwrite non-empty target tables inside the same transaction. */
  replace?: boolean;
  /** Skip cached `price_bar` and `fx_rate` rows (ledger + settings only). */
  skipMarketCache?: boolean;
  /** Maximum rows per multi-row INSERT batch (keeps bind params < 65,535). */
  batchSize?: number;
}

export interface TableCopyStats {
  table: TableKey;
  sourceCount: number;
  copiedCount: number;
  targetCount: number;
}

export interface CopyDatabaseResult {
  tables: TableCopyStats[];
  verified: boolean;
}

interface TableCopySpec {
  key: TableKey;
  isMarketCache: boolean;
  /**
   * Core tables block accidental overwrites when `!replace`.
   * Singleton `settings` and `login_attempt` can safely coexist when the user
   * booted the app once against an empty Neon database before running the copy.
   */
  blockWhenNonEmpty: boolean;
  count: (database: Database) => Promise<number>;
  clear: (tx: Database) => Promise<void>;
  copy: (
    source: Database,
    tx: Database,
    batchSize: number,
    replace: boolean,
  ) => Promise<number>;
}

const DEFAULT_BATCH_SIZE = 500;

async function countTableRows(database: Database, table: PgTable): Promise<number> {
  const rows = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(table);
  return rows[0]?.count ?? 0;
}

function chunkRows<T>(rows: readonly T[], batchSize: number): T[][] {
  const safeSize = Math.max(1, batchSize);
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += safeSize) {
    chunks.push(rows.slice(index, index + safeSize));
  }
  return chunks;
}

function createStandardTableSpec<TTable extends PgTable>(
  key: TableKey,
  table: TTable,
  options: { isMarketCache?: boolean; blockWhenNonEmpty?: boolean; ignoreConflictsWhenAppending?: boolean } = {},
): TableCopySpec {
  return {
    key,
    isMarketCache: options.isMarketCache ?? false,
    blockWhenNonEmpty: options.blockWhenNonEmpty ?? true,
    count: (database) => countTableRows(database, table),
    clear: async (tx) => {
      await tx.delete(table);
    },
    copy: async (source, tx, batchSize, replace) => {
      const rows = await source.select().from(table as PgTable);
      if (rows.length === 0) {
        return 0;
      }

      for (const batch of chunkRows(rows, batchSize)) {
        const query = tx
          .insert(table)
          .values(batch as unknown as TTable["$inferInsert"][]);
        if (!replace && options.ignoreConflictsWhenAppending) {
          await query.onConflictDoNothing();
        } else {
          await query;
        }
      }

      return rows.length;
    },
  };
}

/**
 * Ordered from parent tables to child tables so every foreign-key constraint
 * holds cleanly during insert (and deleted in reverse order on `--replace`).
 */
const TABLE_SPECS: readonly TableCopySpec[] = [
  {
    key: "settings",
    isMarketCache: false,
    blockWhenNonEmpty: false,
    count: (database) => countTableRows(database, schema.settings),
    clear: async (tx) => {
      await tx.delete(schema.settings);
    },
    copy: async (source, tx) => {
      const rows = await source.select().from(schema.settings);
      const localSettings = rows[0];
      if (!localSettings) {
        return 0;
      }

      await tx
        .insert(schema.settings)
        .values(localSettings)
        .onConflictDoUpdate({
          target: schema.settings.id,
          set: {
            baseCurrency: localSettings.baseCurrency,
            riskFreeRate: localSettings.riskFreeRate,
            defaultBenchmark: localSettings.defaultBenchmark,
            costBasisMethod: localSettings.costBasisMethod,
            dividendMode: localSettings.dividendMode,
            theme: localSettings.theme,
            gainColorScheme: localSettings.gainColorScheme,
            numberFormat: localSettings.numberFormat,
            dateFormat: localSettings.dateFormat,
            timezone: localSettings.timezone,
            updatedAt: localSettings.updatedAt,
          },
        });

      return rows.length;
    },
  },
  createStandardTableSpec("csv_import_log", schema.csvImportLog),
  createStandardTableSpec("portfolio", schema.portfolio),
  createStandardTableSpec("instrument", schema.instrument),
  createStandardTableSpec("portfolio_instrument", schema.portfolioInstrument),
  createStandardTableSpec("transaction", schema.transaction),
  createStandardTableSpec("corporate_action", schema.corporateAction),
  createStandardTableSpec("price_bar", schema.priceBar, { isMarketCache: true }),
  createStandardTableSpec("fx_rate", schema.fxRate, { isMarketCache: true }),
  createStandardTableSpec("login_attempt", schema.loginAttempt, {
    blockWhenNonEmpty: false,
    ignoreConflictsWhenAppending: true,
  }),
];

/** Returns row counts for every table in the Folio schema. */
export async function getDatabaseCounts(database: Database): Promise<DatabaseCounts> {
  const entries = await Promise.all(
    TABLE_SPECS.map(async (spec) => [spec.key, await spec.count(database)] as const),
  );
  return Object.fromEntries(entries) as DatabaseCounts;
}

/** Validates and strips surrounding quotes from a `DATABASE_URL` string. */
export function normalizeDatabaseUrlInput(rawUrl: string | undefined): string {
  const trimmed = rawUrl?.trim() ?? "";
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1).trim()
      : trimmed;

  if (unquoted.length === 0) {
    throw new Error(
      'DATABASE_URL is not set. Add DATABASE_URL="postgresql://..." to .env.local first.',
    );
  }

  if (unquoted.toLowerCase().startsWith("psql ")) {
    throw new Error(
      "DATABASE_URL starts with `psql `. Paste only the postgresql://... connection URL (not the full psql command).",
    );
  }

  if (!unquoted.startsWith("postgresql://") && !unquoted.startsWith("postgres://")) {
    throw new Error(
      "DATABASE_URL must start with postgresql:// or postgres://.",
    );
  }

  return unquoted;
}

/**
 * Formats a Postgres connection string with host and database name only so
 * credentials and tokens are never logged.
 */
export function redactPostgresUrl(connectionString: string): {
  display: string;
  isNeon: boolean;
  isPooled: boolean;
} {
  const parsed = new URL(connectionString);
  const host = parsed.hostname;
  const dbName = parsed.pathname.replace(/^\/+/, "") || "(default)";
  return {
    display: `${host}/${dbName}`,
    isNeon: host.endsWith(".neon.tech") || host.includes("neon.tech"),
    isPooled: host.includes("-pooler"),
  };
}

function isRowCountMatch(
  spec: TableCopySpec,
  sourceCount: number,
  targetCount: number,
  replace: boolean,
): boolean {
  if (!replace && !spec.blockWhenNonEmpty) {
    return targetCount >= sourceCount;
  }
  return targetCount === sourceCount;
}

/**
 * Copies every selected table from `source` (local PGlite) into `target`
 * (Neon / hosted Postgres) inside one atomic transaction and verifies post-copy
 * row counts before committing.
 */
export async function copyDatabaseContents(
  source: Database,
  target: Database,
  options: CopyDatabaseOptions = {},
): Promise<CopyDatabaseResult> {
  const replace = options.replace ?? false;
  const skipMarketCache = options.skipMarketCache ?? false;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  const specsToCopy = TABLE_SPECS.filter(
    (spec) => !(skipMarketCache && spec.isMarketCache),
  );

  const sourceCounts = await getDatabaseCounts(source);
  const targetBeforeCounts = await getDatabaseCounts(target);

  if (!replace) {
    const blockingTables = specsToCopy
      .filter((spec) => spec.blockWhenNonEmpty && targetBeforeCounts[spec.key] > 0)
      .map((spec) => `${spec.key} (${targetBeforeCounts[spec.key]} rows)`);

    if (blockingTables.length > 0) {
      throw new Error(
        `Target database already contains data in: ${blockingTables.join(", ")}. Re-run with --replace to overwrite target tables with your local database.`,
      );
    }
  }

  const stats = await target.transaction(async (tx) => {
    const txDb = tx as unknown as Database;

    if (replace) {
      // Clear all tables in strict reverse FK order so parent deletes never fail.
      for (const spec of [...TABLE_SPECS].reverse()) {
        await spec.clear(txDb);
      }
    }

    const copiedCounts = new Map<TableKey, number>();
    for (const spec of specsToCopy) {
      const copied = await spec.copy(source, txDb, batchSize, replace);
      copiedCounts.set(spec.key, copied);
    }

    const results: TableCopyStats[] = [];
    for (const spec of specsToCopy) {
      const sourceCount = sourceCounts[spec.key];
      const copiedCount = copiedCounts.get(spec.key) ?? 0;
      const targetCount = await spec.count(txDb);

      if (!isRowCountMatch(spec, sourceCount, targetCount, replace)) {
        throw new Error(
          `Row count mismatch after copying "${spec.key}": source=${sourceCount}, target=${targetCount}. Rolling back transaction.`,
        );
      }

      results.push({
        table: spec.key,
        sourceCount,
        copiedCount,
        targetCount,
      });
    }

    return results;
  });

  return {
    tables: stats,
    verified: true,
  };
}
