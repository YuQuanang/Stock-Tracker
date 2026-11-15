import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db/client";
import {
  copyDatabaseContents,
  getDatabaseCounts,
  normalizeDatabaseUrlInput,
  redactPostgresUrl,
} from "@/db/copy-local-to-postgres";
import * as schema from "@/db/schema";

const migrationsFolder = path.join(import.meta.dirname, "..", "..", "db", "migrations");

async function createIsolatedDb(): Promise<{ client: PGlite; db: Database }> {
  const client = new PGlite();
  const pgliteDb = drizzle(client, { schema });
  await migrate(pgliteDb, { migrationsFolder });
  return { client, db: pgliteDb as unknown as Database };
}

describe("copy-local-to-postgres", () => {
  let source: Database;
  let target: Database;

  beforeEach(async () => {
    const src = await createIsolatedDb();
    const tgt = await createIsolatedDb();
    source = src.db;
    target = tgt.db;

    const [importLog] = await source
      .insert(schema.csvImportLog)
      .values({
        filename: "My_Stock_Portfolio.csv",
        status: "committed",
        rowCounts: { rowsRead: 2, transactions: 1, placeholders: 1, skipped: 0 },
        warnings: [],
      })
      .returning();

    await source.insert(schema.settings).values({
      id: 1,
      baseCurrency: "SGD",
      riskFreeRate: "0.030000",
      defaultBenchmark: "^GSPC",
      timezone: "Asia/Singapore",
    });

    const [portfolioRow] = await source
      .insert(schema.portfolio)
      .values({
        name: "Main Portfolio",
        type: "holdings",
        defaultCurrency: "SGD",
        sortOrder: 0,
        createdByImportId: importLog.id,
      })
      .returning();

    const [instrumentRow] = await source
      .insert(schema.instrument)
      .values({
        symbol: "ES3.SI",
        name: "SPDR Straits Times Index ETF",
        importName: "STI ETF",
        currency: "SGD",
        assetType: "etf",
      })
      .returning();

    await source.insert(schema.portfolioInstrument).values({
      portfolioId: portfolioRow.id,
      instrumentId: instrumentRow.id,
      sortOrder: 0,
      paperEntryDate: "2024-01-05",
      paperAmount: "1000.000000000000",
      createdByImportId: importLog.id,
    });

    await source.insert(schema.transaction).values({
      portfolioId: portfolioRow.id,
      instrumentId: instrumentRow.id,
      type: "Buy",
      quantity: "100.000000000000",
      price: "3.450000000000",
      commissionRaw: "1.50",
      commissionValue: "1.500000000000",
      commissionIsPercent: false,
      executedAt: new Date("2025-02-05T02:00:00.000Z"),
      originalOffset: "+0800",
      currency: "SGD",
      importId: importLog.id,
      dedupeHash: "hash-1",
    });

    await source.insert(schema.corporateAction).values({
      instrumentId: instrumentRow.id,
      exDate: "2025-06-01",
      type: "split",
      ratioNumerator: 2,
      ratioDenominator: 1,
    });

    await source.insert(schema.priceBar).values([
      { instrumentId: instrumentRow.id, date: "2025-02-05", close: "3.450000000000", source: "yahoo" },
      { instrumentId: instrumentRow.id, date: "2025-02-06", close: "3.460000000000", source: "yahoo" },
      { instrumentId: instrumentRow.id, date: "2025-02-07", close: "3.470000000000", source: "yahoo" },
      { instrumentId: instrumentRow.id, date: "2025-02-10", close: "3.480000000000", source: "tradingview" },
      { instrumentId: instrumentRow.id, date: "2025-02-11", close: "3.500000000000", source: "tradingview" },
    ]);

    await source.insert(schema.fxRate).values([
      { date: "2025-02-05", fromCurrency: "USD", toCurrency: "SGD", rate: "1.3510000000", source: "frankfurter" },
      { date: "2025-02-06", fromCurrency: "USD", toCurrency: "SGD", rate: "1.3520000000", source: "frankfurter" },
      { date: "2025-02-07", fromCurrency: "USD", toCurrency: "SGD", rate: "1.3530000000", source: "frankfurter" },
    ]);

    await source.insert(schema.loginAttempt).values({
      key: "global",
      succeeded: true,
    });
  });

  it("copies all tables in dependency order with batching and exact count verification", async () => {
    const result = await copyDatabaseContents(source, target, { batchSize: 2 });
    expect(result.verified).toBe(true);

    const sourceCounts = await getDatabaseCounts(source);
    const targetCounts = await getDatabaseCounts(target);
    expect(targetCounts).toEqual(sourceCounts);

    const [copiedPortfolio] = await target.select().from(schema.portfolio);
    const [copiedTx] = await target.select().from(schema.transaction);
    const [copiedSplit] = await target.select().from(schema.corporateAction);
    const [copiedSettings] = await target.select().from(schema.settings);

    expect(copiedPortfolio.name).toBe("Main Portfolio");
    expect(copiedTx.portfolioId).toBe(copiedPortfolio.id);
    expect(copiedTx.price).toBe("3.450000000000");
    expect(copiedSplit.ratioNumerator).toBe(2);
    expect(copiedSettings.riskFreeRate).toBe("0.030000");
  });

  it("refuses to overwrite non-empty ledger unless replace is set, then replaces atomically", async () => {
    await copyDatabaseContents(source, target);

    await expect(copyDatabaseContents(source, target)).rejects.toThrow(
      /already contains data.*--replace/i,
    );

    const replaced = await copyDatabaseContents(source, target, { replace: true });
    expect(replaced.verified).toBe(true);
    expect(await getDatabaseCounts(target)).toEqual(await getDatabaseCounts(source));
  });

  it("coexists with pre-seeded default settings and login attempts without --replace", async () => {
    await target.insert(schema.settings).values({
      id: 1,
      baseCurrency: "USD",
      riskFreeRate: "0.045000",
    });
    await target.insert(schema.loginAttempt).values({
      key: "global",
      succeeded: false,
    });

    const result = await copyDatabaseContents(source, target);
    expect(result.verified).toBe(true);

    const [copiedSettings] = await target.select().from(schema.settings);
    expect(copiedSettings.baseCurrency).toBe("SGD");
    expect(copiedSettings.riskFreeRate).toBe("0.030000");

    const targetCounts = await getDatabaseCounts(target);
    expect(targetCounts.login_attempt).toBe(2);
    expect(targetCounts.transaction).toBe(1);
  });

  it("supports skipping cached market data tables", async () => {
    const result = await copyDatabaseContents(source, target, { skipMarketCache: true });
    expect(result.verified).toBe(true);

    const targetCounts = await getDatabaseCounts(target);
    expect(targetCounts.transaction).toBe(1);
    expect(targetCounts.corporate_action).toBe(1);
    expect(targetCounts.price_bar).toBe(0);
    expect(targetCounts.fx_rate).toBe(0);
  });

  it("validates and redacts Postgres/Neon connection URLs safely", () => {
    expect(
      normalizeDatabaseUrlInput(' "postgresql://user:secret@ep-x-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require" '),
    ).toBe(
      "postgresql://user:secret@ep-x-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require",
    );

    expect(() => normalizeDatabaseUrlInput("")).toThrow(/DATABASE_URL is not set/);
    expect(() => normalizeDatabaseUrlInput("psql 'postgresql://...'")).toThrow(/psql/);
    expect(() => normalizeDatabaseUrlInput("mysql://host/db")).toThrow(/postgresql:\/\//);

    const redacted = redactPostgresUrl(
      "postgresql://neondb_owner:supersecretpassword@ep-muddy-glade-12345-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require",
    );
    expect(redacted).toEqual({
      display: "ep-muddy-glade-12345-pooler.ap-southeast-1.aws.neon.tech/neondb",
      isNeon: true,
      isPooled: true,
    });
    expect(JSON.stringify(redacted)).not.toContain("supersecretpassword");
    expect(JSON.stringify(redacted)).not.toContain("neondb_owner");
  });
});

