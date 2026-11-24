import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryTestDatabase, type Database } from "@/db/client";
import { writeRejectedRowsCsv } from "@/lib/csv";
import {
  commitCsvImport,
  exportCleanCsvFromDb,
  exportFullBackupJson,
  exportMspCsvFromDb,
  exportPlainTemplateCsv,
  listCsvImportLogs,
  previewCsvImport,
  undoCsvImport,
} from "@/lib/services/csv-import-export";
import {
  computeLedgerSummaries,
  createTransaction,
  LedgerUserError,
  listEnrichedTransactions,
  listInstruments,
  listPortfolios,
  updateInstrumentOverrides,
} from "@/lib/services/ledger";

const fixturePath = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "MSP-Portfolios-2026-11-07.csv",
);
const fixtureCsv = fs.readFileSync(fixturePath, "utf8");

describe("Milestone 3: Lossless MSP CSV Import, Export, Validation, Backup & Undo", () => {
  let db: Database;

  beforeEach(async () => {
    db = await createInMemoryTestDatabase();
  });

  it("round-trips MSP-Portfolios-2026-11-07.csv 100% byte-for-byte across all 273 rows", async () => {
    const preview = await previewCsvImport(fixtureCsv, db);

    expect(preview.format).toBe("msp");
    expect(preview.totalDataRows).toBe(273);
    expect(preview.placeholderCount).toBe(53);
    expect(preview.transactionCount).toBe(220);
    expect(preview.rejectedRows).toHaveLength(0);
    expect(preview.duplicateTransactionCount).toBe(0);

    // Exact 5 portfolios with "My Portfolio" inferred as a watchlist
    expect(
      preview.portfolios.map((p) => ({
        name: p.name,
        type: p.inferredType,
        txCount: p.transactionCount,
      })),
    ).toEqual([
      { name: "My Portfolio", type: "watchlist", txCount: 0 },
      { name: "US Stocks", type: "holdings", txCount: 101 },
      { name: "SG Stocks", type: "holdings", txCount: 67 },
      { name: "Crypto Portfolio", type: "holdings", txCount: 12 },
      { name: "Current", type: "holdings", txCount: 40 },
    ]);

    // Warnings surface zero-cost buys, unpriced crypto, and HIBB empty metadata
    expect(preview.warnings.some((w) => w.kind === "zero_cost_buy")).toBe(true);
    expect(preview.warnings.some((w) => w.kind === "crypto_unpriced")).toBe(
      true,
    );
    expect(preview.warnings.some((w) => w.kind === "missing_metadata")).toBe(
      true,
    );

    const commit = await commitCsvImport(
      {
        filename: "MSP-Portfolios-2026-11-07.csv",
        csvText: fixtureCsv,
        duplicateMode: "skip",
      },
      db,
    );

    expect(commit.rowCounts).toEqual({
      rowsRead: 273,
      validRows: 273,
      portfoliosCreated: 5,
      instrumentsTracked: 53,
      transactionsImported: 220,
      skippedDuplicates: 0,
      rejectedRows: 0,
    });
    expect(commit.unresolvedSymbols.length).toBeGreaterThanOrEqual(6);

    // Enrich HIBB's UI display name in the DB and verify lossless export STILL
    // emits empty "" for HIBB's Name in MSP format!
    const instruments = await listInstruments(db);
    const hibb = instruments.find((i) => i.symbol === "HIBB");
    expect(hibb).toBeDefined();
    expect(hibb?.importName).toBe("");
    expect(hibb?.exchangeCode).toBeNull();

    await updateInstrumentOverrides(
      hibb!.id,
      { name: "Hibbett, Inc." },
      db,
    );

    // Verify ETH-SGD 10-decimal precision and CFA.SI "1%" commission in DB
    const allTx = await listEnrichedTransactions({}, db);
    const ethBuy = allTx.find(
      (tx) => tx.symbol === "ETH-SGD" && tx.price === "4649.8599439776",
    );
    expect(ethBuy).toBeDefined();
    expect(ethBuy?.currency).toBe("SGD");

    const cfaPercentSell = allTx.find(
      (tx) => tx.symbol === "CFA.SI" && tx.commissionRaw === "1%",
    );
    expect(cfaPercentSell).toBeDefined();
    expect(cfaPercentSell?.commissionIsPercent).toBe(true);

    // Verify FIFO ledgers compute cleanly across all 5 portfolios and that
    // INTC's Sell All in Current also closed INTC's shares in US Stocks
    const ledgerSummary = await computeLedgerSummaries(undefined, db);
    const intcPositions = ledgerSummary.positions.filter(
      (p) => p.symbol === "INTC",
    );
    expect(intcPositions).toHaveLength(2);
    for (const pos of intcPositions) {
      expect(pos.sharesHeld).toBe("0");
    }

    // Export back to MSP format and assert 100% byte-for-byte identity
    const exported = await exportMspCsvFromDb({}, db);
    expect(exported.content).toBe(fixtureCsv);
  });

  it("handles duplicate re-imports cleanly across skip, replace, and append modes", async () => {
    await commitCsvImport(
      {
        filename: "MSP-Portfolios-2026-11-07.csv",
        csvText: fixtureCsv,
        duplicateMode: "skip",
      },
      db,
    );

    // Previewing a second time detects all 220 duplicate transactions
    const secondPreview = await previewCsvImport(fixtureCsv, db);
    expect(secondPreview.duplicateTransactionCount).toBe(220);

    // 1. Skip mode is 100% idempotent
    const skipCommit = await commitCsvImport(
      {
        filename: "MSP-Portfolios-2026-11-07.csv",
        csvText: fixtureCsv,
        duplicateMode: "skip",
      },
      db,
    );
    expect(skipCommit.rowCounts.transactionsImported).toBe(0);
    expect(skipCommit.rowCounts.skippedDuplicates).toBe(220);
    expect((await exportMspCsvFromDb({}, db)).content).toBe(fixtureCsv);

    // 2. Replace mode wipes and cleanly reconstructs the portfolios
    const replaceCommit = await commitCsvImport(
      {
        filename: "MSP-Portfolios-2026-11-07.csv",
        csvText: fixtureCsv,
        duplicateMode: "replace",
      },
      db,
    );
    expect(replaceCommit.rowCounts.transactionsImported).toBe(220);
    expect(replaceCommit.rowCounts.skippedDuplicates).toBe(0);
    expect((await exportMspCsvFromDb({}, db)).content).toBe(fixtureCsv);

    // 3. Append mode deliberately duplicates matching buy rows
    const miniPlainCsv = [
      "Symbol,Name,Exchange,Portfolio,Currency,Type,Shares,Price,Commission,Date,Time,Notes",
      '"NVDA","NVIDIA Corporation","NMS","Current","USD","Buy","3","205","0","2026-11-03","08:44:00",""',
    ].join("\n");

    const appendCommit = await commitCsvImport(
      {
        filename: "append-nvda.csv",
        csvText: miniPlainCsv,
        duplicateMode: "append",
      },
      db,
    );
    expect(appendCommit.rowCounts.transactionsImported).toBe(1);
    const nvdaRows = (await listEnrichedTransactions({}, db)).filter(
      (tx) => tx.symbol === "NVDA" && tx.portfolioName === "Current",
    );
    expect(nvdaRows).toHaveLength(3);
  });

  it("isolates invalid and oversold rows with exact line numbers while importing valid rows", async () => {
    const mixedCsvWithBomAndCrlf =
      "\uFEFF" +
      [
        "Symbol,Name,Exchange,Portfolio,Currency,Type,Shares,Price,Commission,Date,Time,Notes",
        '"AAPL","Apple Inc.","NMS","Core","USD","Buy","10","180.25","1.00","2025-03-10","09:30:00","Multi-line\nnote with ""quotes"""',
        '"AAPL","Apple Inc.","NMS","Core","USD","Transfer","5","180.00","0","2025-03-11","09:30:00","Bad type"',
        '"AAPL","Apple Inc.","NMS","Core","USD","Buy","ten","182.00","0","2025-03-12","09:30:00","Non-numeric shares"',
        '"AAPL","Apple Inc.","NMS","Core","USD","Buy","5","183.00","0","2025-02-30","09:30:00","Impossible calendar date"',
        '"AAPL","Apple Inc.","NMS","Core","USD","Sell","25","190.00","0","2025-03-15","09:30:00","Oversells 10 held shares"',
        '"AAPL","Apple Inc.","NMS","Core","USD","Sell","4","191.50","0","2025-03-16","09:30:00","Valid partial sell"',
      ].join("\r\n");

    const preview = await previewCsvImport(mixedCsvWithBomAndCrlf, db);

    // Note: line 2 spans physical lines 2-3 because of the embedded newline inside quotes!
    expect(preview.transactionCount).toBe(2);
    expect(preview.rejectedRows).toHaveLength(4);
    expect(preview.rejectedRows.map((r) => r.lineNumber)).toEqual([
      4, 5, 6, 7,
    ]);

    const rejectedCsv = writeRejectedRowsCsv(
      preview.headers,
      preview.rejectedRows,
    );
    expect(rejectedCsv).toContain("LineNumber,ErrorReason,Symbol");
    expect(rejectedCsv).toContain('Unknown transaction Type ""Transfer""');
    expect(rejectedCsv).toContain("Cannot sell 25 shares of AAPL");

    const commit = await commitCsvImport(
      {
        filename: "mixed.csv",
        csvText: mixedCsvWithBomAndCrlf,
        duplicateMode: "skip",
      },
      db,
    );
    expect(commit.rowCounts.transactionsImported).toBe(2);
    expect(commit.rowCounts.rejectedRows).toBe(4);

    const saved = await listEnrichedTransactions({}, db);
    expect(saved).toHaveLength(2);
    const buyRow = saved.find((tx) => tx.type === "Buy");
    expect(buyRow?.notes).toBe('Multi-line\nnote with "quotes"');
  });

  it("imports plain CSV template, sanitizes spreadsheet formulas in Clean CSV only, and exports JSON backup", async () => {
    const template = exportPlainTemplateCsv();
    const commit = await commitCsvImport(
      {
        filename: template.filename,
        csvText: template.content,
        duplicateMode: "skip",
      },
      db,
    );
    expect(commit.rowCounts.transactionsImported).toBe(3);

    const portfolios = await listPortfolios(db);
    const usPortfolio = portfolios.find((p) => p.name === "US Stocks")!;

    await createTransaction(
      {
        portfolioId: usPortfolio.id,
        symbol: "AAPL",
        instrumentName: "Apple Inc.",
        exchangeCode: "NMS",
        type: "Buy",
        quantity: "2",
        price: "195.00",
        date: "2025-04-01",
        time: "10:00:00",
        notes: "=CMD|' /C calc'!A0",
      },
      db,
    );

    const cleanExport = await exportCleanCsvFromDb({}, db);
    expect(cleanExport.content).toContain("'=CMD|' /C calc'!A0");

    const mspExport = await exportMspCsvFromDb({}, db);
    expect(mspExport.content).toContain('"=CMD|\' /C calc\'!A0"');
    expect(mspExport.content).not.toContain("'=CMD|");

    const backup = await exportFullBackupJson(db);
    const parsedBackup = JSON.parse(backup.content) as {
      schemaVersion: number;
      portfolios: unknown[];
      transactions: unknown[];
      mspCsv: string;
    };
    expect(parsedBackup.schemaVersion).toBe(1);
    expect(parsedBackup.portfolios).toHaveLength(2);
    expect(parsedBackup.transactions).toHaveLength(4);
    expect(parsedBackup.mspCsv).toBe(mspExport.content);
  });

  it("undoes an import atomically and blocks undo when a later manual Sell depends on imported Buys", async () => {
    const commit = await commitCsvImport(
      {
        filename: "MSP-Portfolios-2026-11-07.csv",
        csvText: fixtureCsv,
        duplicateMode: "skip",
      },
      db,
    );

    await undoCsvImport(commit.importId, db);

    expect(await listPortfolios(db)).toHaveLength(0);
    expect(await listInstruments(db)).toHaveLength(0);
    expect(await listEnrichedTransactions({}, db)).toHaveLength(0);

    const logs = await listCsvImportLogs(db);
    expect(logs[0]?.status).toBe("undone");
    expect(logs[0]?.undoneAt).not.toBeNull();

    // Now import a Buy, record a subsequent manual Sell against those shares,
    // and verify Undo refuses to leave an oversold ledger!
    const template = exportPlainTemplateCsv();
    const secondCommit = await commitCsvImport(
      {
        filename: "template.csv",
        csvText: template.content,
        duplicateMode: "skip",
      },
      db,
    );

    const usPortfolio = (await listPortfolios(db)).find(
      (p) => p.name === "US Stocks",
    )!;

    await createTransaction(
      {
        portfolioId: usPortfolio.id,
        symbol: "AAPL",
        type: "Sell",
        quantity: "5",
        price: "210.00",
        date: "2025-06-01",
        time: "10:00:00",
      },
      db,
    );

    await expect(undoCsvImport(secondCommit.importId, db)).rejects.toThrow(
      LedgerUserError,
    );

    // Transaction rollback kept the ledger intact (Buy 10 + Sell 5 = 2 rows on AAPL)
    const remaining = (await listEnrichedTransactions({}, db)).filter(
      (tx) => tx.symbol === "AAPL",
    );
    expect(remaining).toHaveLength(2);
  });
});
