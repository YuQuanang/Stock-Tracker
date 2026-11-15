/**
 * Server-side CSV Import, Lossless Export, Full Backup, and Import Undo Service.
 *
 * Implements Section 7 of the Folio specification:
 *  - Preview step (no database writes) with per-portfolio counts, duplicate
 *    detection, data-quality warnings, and per-row error reporting
 *  - Atomic commit inside a PostgreSQL transaction (`skip`, `replace`, `append`)
 *  - Lossless 19-column Microsoft Start (`MSP-Portfolios-YYYY-MM-DD.csv`) export
 *  - Clean modern CSV export (with formula-injection protection)
 *  - One-click full JSON backup export
 *  - Atomic Undo Import (`csv_import_log` rollback with FIFO invariant check)
 */
import { and, asc, desc, eq } from "drizzle-orm";
import { type Database, getDb } from "@/db/client";
import {
  corporateAction,
  csvImportLog,
  instrument,
  type Instrument,
  portfolio,
  type Portfolio,
  portfolioInstrument,
  priceBar,
  transaction,
} from "@/db/schema";
import {
  type CleanCsvRowInput,
  CsvFormatError,
  type CsvSamplePreviewRow,
  type CsvWarningItem,
  type DetectedCsvFormat,
  generatePlainCsvTemplate,
  type MspExportSymbolGroup,
  type MspExportTransactionItem,
  parsePortfolioCsv,
  type PortfolioPreviewSummary,
  type RejectedCsvRow,
  validateParsedCsv,
  type ValidTransactionType,
  writeCleanCsv,
  writeMspCsv,
} from "@/lib/csv";
import {
  evaluateFifoLedger,
  FifoValidationError,
  formatInstantInOffset,
  toDecimal,
  toDecimalString,
} from "@/lib/finance";
import {
  getOrCreateSettings,
  LedgerUserError,
  listEnrichedTransactions,
  listPortfolios,
  mapDbTransactionToFifoInput,
} from "@/lib/services/ledger";
import {
  ensureHistoricalUsdSgdRates,
  reconcileLedgerPairsSgdTotals,
} from "@/lib/services/fx-sgd";
import type { AssetClass } from "@/lib/symbols";

export type DuplicateImportMode = "skip" | "replace" | "append";

export interface EnrichedPortfolioPreview extends PortfolioPreviewSummary {
  duplicateTransactionCount: number;
  alreadyExists: boolean;
}

export interface CsvPreviewResponse {
  format: DetectedCsvFormat;
  headers: string[];
  totalDataRows: number;
  placeholderCount: number;
  transactionCount: number;
  duplicateTransactionCount: number;
  portfolios: EnrichedPortfolioPreview[];
  typeCounts: Record<ValidTransactionType, number>;
  detectedSymbols: {
    symbol: string;
    name: string;
    exchange: string;
    currency: "USD" | "SGD";
    assetType: AssetClass;
  }[];
  warnings: CsvWarningItem[];
  rejectedRows: RejectedCsvRow[];
  sampleRows: CsvSamplePreviewRow[];
}

export interface CsvSymbolResolutionItem {
  symbol: string;
  portfolioNames: string[];
  status: "unpriced_crypto" | "missing_exchange";
  message: string;
}

export interface CsvImportRowCounts {
  rowsRead: number;
  validRows: number;
  portfoliosCreated: number;
  instrumentsTracked: number;
  transactionsImported: number;
  skippedDuplicates: number;
  rejectedRows: number;
}

export interface CsvCommitResult {
  importId: string;
  filename: string;
  duplicateMode: DuplicateImportMode;
  rowCounts: CsvImportRowCounts;
  warnings: CsvWarningItem[];
  unresolvedSymbols: CsvSymbolResolutionItem[];
}

export interface CsvImportLogEntry {
  id: string;
  filename: string;
  status: "committed" | "undone";
  rowCounts: Partial<CsvImportRowCounts>;
  warnings: CsvWarningItem[];
  createdAt: string;
  undoneAt: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseCsvOrThrowUserError(csvText: string) {
  try {
    return parsePortfolioCsv(csvText);
  } catch (error) {
    if (error instanceof CsvFormatError) {
      throw new LedgerUserError(error.message, 400);
    }
    throw error;
  }
}

/**
 * Builds a multiset count map of `(portfolioName::dedupeHash -> count)` for
 * transactions currently stored in the database.
 *
 * Using a multiset count instead of a plain boolean Set ensures that:
 *  - On first import, two legitimate partial fills in the same CSV file are
 *    both imported cleanly.
 *  - On re-importing the same CSV file in `"skip"` mode, both rows match the
 *    existing count of 2 and are skipped idempotently.
 */
async function loadExistingDedupeHashCounts(
  database: Database,
): Promise<Map<string, number>> {
  const existingTxRows = await database
    .select({
      portfolioName: portfolio.name,
      dedupeHash: transaction.dedupeHash,
    })
    .from(transaction)
    .innerJoin(portfolio, eq(transaction.portfolioId, portfolio.id));

  const counts = new Map<string, number>();
  for (const row of existingTxRows) {
    const key = `${row.portfolioName}::${row.dedupeHash}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function buildSgdSnapshotForImportedRow(params: {
  type: ValidTransactionType;
  currency: "USD" | "SGD";
  quantity: string;
  price: string;
  executedAt: Date;
  purchaseFxRate: string | null;
  purchaseFxCurrencies: string | null;
}) {
  if (params.currency === "SGD") {
    const rateOne = toDecimalString(toDecimal(1), 12);
    let totalCostSgd: string | null = null;
    if (params.type !== "Sell All") {
      const qtyDec = toDecimal(params.quantity);
      const priceDec = toDecimal(params.price);
      const totalDec =
        params.type === "Dividend" ? qtyDec : qtyDec.mul(priceDec);
      totalCostSgd = toDecimalString(totalDec, 12);
    }
    return {
      fxRateToSgd: rateOne,
      fxAsOf: params.executedAt,
      fxSource: "native-sgd",
      totalCostSgd,
    };
  }

  // For USD rows, only populate SGD snapshot if the CSV explicitly supplied a
  // USD -> SGD rate. Never fabricate historical FX rates on import.
  const fxPairUpper = (params.purchaseFxCurrencies ?? "").toUpperCase();
  const hasExplicitSgdFx =
    params.purchaseFxRate !== null &&
    (fxPairUpper === "" || fxPairUpper.includes("SGD"));

  if (hasExplicitSgdFx && params.purchaseFxRate !== null) {
    const fxDec = toDecimal(params.purchaseFxRate);
    let totalCostSgd: string | null = null;
    if (params.type !== "Sell All") {
      const qtyDec = toDecimal(params.quantity);
      const priceDec = toDecimal(params.price);
      const totalDec =
        params.type === "Dividend"
          ? qtyDec.mul(fxDec)
          : qtyDec.mul(priceDec).mul(fxDec);
      totalCostSgd = toDecimalString(totalDec, 12);
    }
    return {
      fxRateToSgd: toDecimalString(fxDec, 12),
      fxAsOf: params.executedAt,
      fxSource: "csv-import",
      totalCostSgd,
    };
  }

  return {
    fxRateToSgd: null,
    fxAsOf: null,
    fxSource: null,
    totalCostSgd: null,
  };
}

async function assertDbPairFifoValid(params: {
  database: Database;
  portfolioId: string;
  instrumentId: string;
  symbol: string;
  dividendMode: "cash" | "shares";
}): Promise<void> {
  const rows = await params.database
    .select()
    .from(transaction)
    .where(
      and(
        eq(transaction.portfolioId, params.portfolioId),
        eq(transaction.instrumentId, params.instrumentId),
      ),
    );

  if (rows.length === 0) {
    return;
  }

  const splitRows = await params.database
    .select()
    .from(corporateAction)
    .where(eq(corporateAction.instrumentId, params.instrumentId))
    .orderBy(asc(corporateAction.exDate));

  try {
    evaluateFifoLedger(rows.map(mapDbTransactionToFifoInput), {
      symbol: params.symbol,
      dividendMode: params.dividendMode,
      splits: splitRows.map((s) => ({
        id: s.id,
        exDate: s.exDate,
        ratioNumerator: s.ratioNumerator,
        ratioDenominator: s.ratioDenominator,
      })),
      onValidationError: "throw",
    });
  } catch (error) {
    if (error instanceof FifoValidationError) {
      throw new LedgerUserError(error.message, 422);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 1. Preview CSV Import (no database writes)
// ---------------------------------------------------------------------------

export async function previewCsvImport(
  csvText: string,
  db?: Database,
): Promise<CsvPreviewResponse> {
  const database = db ?? (await getDb());
  const doc = parseCsvOrThrowUserError(csvText);

  const [appSettings, existingInstruments, existingPortfolios, existingHashes] =
    await Promise.all([
      getOrCreateSettings(database),
      database
        .select({ symbol: instrument.symbol, currency: instrument.currency })
        .from(instrument),
      listPortfolios(database),
      loadExistingDedupeHashCounts(database),
    ]);

  const existingSymbolCurrencies = new Map<string, string>();
  for (const item of existingInstruments) {
    existingSymbolCurrencies.set(item.symbol, item.currency);
  }

  const validation = validateParsedCsv(doc, {
    dividendMode: appSettings.dividendMode,
    existingSymbolCurrencies,
  });

  const existingPortfolioNames = new Set(existingPortfolios.map((p) => p.name));
  const remainingHashes = new Map(existingHashes);
  const duplicatesByPortfolio = new Map<string, number>();
  let duplicateTransactionCount = 0;

  for (const row of validation.validRows) {
    if (row.kind !== "transaction") {
      continue;
    }
    const key = `${row.portfolio}::${row.dedupeHash}`;
    const available = remainingHashes.get(key) ?? 0;
    if (available > 0) {
      remainingHashes.set(key, available - 1);
      duplicateTransactionCount += 1;
      duplicatesByPortfolio.set(
        row.portfolio,
        (duplicatesByPortfolio.get(row.portfolio) ?? 0) + 1,
      );
    }
  }

  const enrichedPortfolios: EnrichedPortfolioPreview[] =
    validation.portfolios.map((p) => ({
      ...p,
      duplicateTransactionCount: duplicatesByPortfolio.get(p.name) ?? 0,
      alreadyExists: existingPortfolioNames.has(p.name),
    }));

  return {
    format: validation.format,
    headers: validation.headers,
    totalDataRows: validation.totalDataRows,
    placeholderCount: validation.placeholderCount,
    transactionCount: validation.transactionCount,
    duplicateTransactionCount,
    portfolios: enrichedPortfolios,
    typeCounts: validation.typeCounts,
    detectedSymbols: validation.detectedSymbols,
    warnings: validation.warnings,
    rejectedRows: validation.rejectedRows,
    sampleRows: validation.sampleRows,
  };
}

// ---------------------------------------------------------------------------
// 2. Commit CSV Import (atomic transaction)
// ---------------------------------------------------------------------------

export interface CommitCsvImportInput {
  filename: string;
  csvText: string;
  duplicateMode: DuplicateImportMode;
  fetchImpl?: typeof fetch;
}

export async function commitCsvImport(
  input: CommitCsvImportInput,
  db?: Database,
): Promise<CsvCommitResult> {
  const database = db ?? (await getDb());
  const cleanFilename = input.filename.trim() || "import.csv";
  const doc = parseCsvOrThrowUserError(input.csvText);

  // Pre-warm historical USD -> SGD exchange rates for all USD trade dates in
  // the CSV BEFORE opening the database transaction so network I/O never holds
  // open a transaction lock.
  const candidateUsdDates: string[] = [];
  for (const rawRow of doc.rows) {
    if (rawRow.type.trim() === "" || rawRow.purchaseExchangeRate.trim() !== "") {
      continue;
    }
    const currUpper = rawRow.currency.trim().toUpperCase();
    const symUpper = rawRow.symbol.trim().toUpperCase();
    const isLikelyUsd =
      currUpper === "USD" ||
      (currUpper === "" &&
        !symUpper.endsWith(".SI") &&
        !symUpper.endsWith("-SGD"));

    if (isLikelyUsd) {
      const dateMatch = rawRow.transactionDate.trim().match(/^(\d{4}-\d{2}-\d{2})/);
      if (dateMatch?.[1]) {
        candidateUsdDates.push(dateMatch[1]);
      }
    }
  }

  const historicalFx = await ensureHistoricalUsdSgdRates({
    dates: candidateUsdDates,
    database,
    fetchImpl: input.fetchImpl,
  });

  return database.transaction(async (txDb) => {
    const txDatabase = txDb as unknown as Database;
    const appSettings = await getOrCreateSettings(txDatabase);

    const existingInstruments = await txDatabase.select().from(instrument);
    const instrumentBySymbol = new Map<string, Instrument>();
    const existingSymbolCurrencies = new Map<string, string>();
    for (const item of existingInstruments) {
      instrumentBySymbol.set(item.symbol, item);
      existingSymbolCurrencies.set(item.symbol, item.currency);
    }

    const validation = validateParsedCsv(doc, {
      dividendMode: appSettings.dividendMode,
      existingSymbolCurrencies,
    });

    if (validation.validRows.length === 0) {
      throw new LedgerUserError(
        "No valid rows remain to import after validation. Fix the reported row errors and try again.",
        422,
      );
    }

    const [importLog] = await txDatabase
      .insert(csvImportLog)
      .values({
        filename: cleanFilename,
        status: "committed",
        rowCounts: {},
        warnings: validation.warnings,
      })
      .returning();

    const currentPortfolios = await listPortfolios(txDatabase);
    const portfolioByName = new Map<string, Portfolio>();
    for (const p of currentPortfolios) {
      portfolioByName.set(p.name, p);
    }

    let nextPortfolioSortOrder =
      currentPortfolios.length === 0
        ? 0
        : Math.max(...currentPortfolios.map((p) => p.sortOrder)) + 1;

    // In "replace" mode, wipe transactions and tracked symbols in each target
    // portfolio before re-populating from the CSV.
    if (input.duplicateMode === "replace") {
      for (const pSummary of validation.portfolios) {
        const existingP = portfolioByName.get(pSummary.name);
        if (existingP) {
          await txDatabase
            .delete(transaction)
            .where(eq(transaction.portfolioId, existingP.id));
          await txDatabase
            .delete(portfolioInstrument)
            .where(eq(portfolioInstrument.portfolioId, existingP.id));
        }
      }
    }

    const remainingExistingHashes =
      input.duplicateMode === "skip"
        ? await loadExistingDedupeHashCounts(txDatabase)
        : new Map<string, number>();

    let portfoliosCreated = 0;

    // Ensure every portfolio exists in exact CSV appearance order
    for (const pSummary of validation.portfolios) {
      const existingP = portfolioByName.get(pSummary.name);
      if (existingP) {
        const shouldUpgradeToHoldings =
          existingP.type === "watchlist" &&
          pSummary.inferredType === "holdings";
        const shouldResetInReplace =
          input.duplicateMode === "replace" &&
          (existingP.type !== pSummary.inferredType ||
            existingP.defaultCurrency !== pSummary.defaultCurrency);

        if (shouldUpgradeToHoldings || shouldResetInReplace) {
          const [updatedP] = await txDatabase
            .update(portfolio)
            .set({
              type: shouldUpgradeToHoldings
                ? "holdings"
                : pSummary.inferredType,
              defaultCurrency: shouldResetInReplace
                ? pSummary.defaultCurrency
                : existingP.defaultCurrency,
            })
            .where(eq(portfolio.id, existingP.id))
            .returning();
          if (updatedP) {
            portfolioByName.set(pSummary.name, updatedP);
          }
        }
        continue;
      }

      const [createdP] = await txDatabase
        .insert(portfolio)
        .values({
          name: pSummary.name,
          type: pSummary.inferredType,
          defaultCurrency: pSummary.defaultCurrency,
          sortOrder: nextPortfolioSortOrder,
          createdByImportId: importLog.id,
        })
        .returning();

      nextPortfolioSortOrder += 1;
      portfoliosCreated += 1;
      portfolioByName.set(pSummary.name, createdP);
    }

    // Track existing (portfolioId, instrumentId) pairs and per-portfolio sortOrder
    const existingPiRows = await txDatabase.select().from(portfolioInstrument);
    const existingPiKeys = new Set<string>();
    const nextPiSortOrder = new Map<string, number>();
    for (const pi of existingPiRows) {
      existingPiKeys.add(`${pi.portfolioId}::${pi.instrumentId}`);
      const currentMax = nextPiSortOrder.get(pi.portfolioId) ?? -1;
      if (pi.sortOrder >= currentMax) {
        nextPiSortOrder.set(pi.portfolioId, pi.sortOrder + 1);
      }
    }

    let instrumentsTracked = 0;
    let transactionsImported = 0;
    let skippedDuplicates = 0;

    const affectedLedgers = new Map<
      string,
      { portfolioId: string; instrumentId: string; symbol: string }
    >();
    const sgdReconcilePairs = new Map<
      string,
      { portfolioId: string; instrumentId: string; symbol: string }
    >();
    const portfoliosPerSymbol = new Map<string, Set<string>>();

    for (const row of validation.validRows) {
      const targetPortfolio = portfolioByName.get(row.portfolio);
      if (!targetPortfolio) {
        throw new LedgerUserError(
          `Internal error: portfolio "${row.portfolio}" was not initialised.`,
          500,
        );
      }

      const pSet = portfoliosPerSymbol.get(row.symbol) ?? new Set<string>();
      pSet.add(row.portfolio);
      portfoliosPerSymbol.set(row.symbol, pSet);

      // Upsert instrument while preserving exact raw CSV strings for lossless MSP round-trip
      let targetInstrument = instrumentBySymbol.get(row.symbol);
      if (!targetInstrument) {
        const isMsp = doc.format === "msp";
        const defaultExchange =
          !isMsp &&
          row.rawExchange === "" &&
          row.symbol.toUpperCase().endsWith(".SI")
            ? "SES"
            : row.rawExchange || null;

        const [createdInstr] = await txDatabase
          .insert(instrument)
          .values({
            symbol: row.symbol,
            name: row.rawName.trim() || null,
            importName: isMsp ? row.rawName : null,
            importDisplaySymbol: isMsp ? row.rawDisplaySymbol : null,
            exchangeCode: defaultExchange,
            currency: row.currency,
            assetType: row.assetType,
          })
          .returning();

        targetInstrument = createdInstr;
        instrumentBySymbol.set(row.symbol, createdInstr);
      } else if (doc.format === "msp") {
        const shouldSetImportFields =
          input.duplicateMode === "replace" ||
          targetInstrument.importName === null;
        const nextImportName = shouldSetImportFields
          ? row.rawName
          : targetInstrument.importName;
        const nextImportDisplay = shouldSetImportFields
          ? row.rawDisplaySymbol
          : targetInstrument.importDisplaySymbol;
        const nextName =
          targetInstrument.name ?? (row.rawName.trim() || null);
        const nextExchange =
          input.duplicateMode === "replace"
            ? row.rawExchange || null
            : (targetInstrument.exchangeCode ?? (row.rawExchange || null));

        if (
          nextImportName !== targetInstrument.importName ||
          nextImportDisplay !== targetInstrument.importDisplaySymbol ||
          nextName !== targetInstrument.name ||
          nextExchange !== targetInstrument.exchangeCode
        ) {
          const [updatedInstr] = await txDatabase
            .update(instrument)
            .set({
              name: nextName,
              importName: nextImportName,
              importDisplaySymbol: nextImportDisplay,
              exchangeCode: nextExchange,
            })
            .where(eq(instrument.id, targetInstrument.id))
            .returning();
          if (updatedInstr) {
            targetInstrument = updatedInstr;
            instrumentBySymbol.set(row.symbol, updatedInstr);
          }
        }
      } else {
        const nextName =
          targetInstrument.name ?? (row.rawName.trim() || null);
        const nextExchange =
          targetInstrument.exchangeCode ?? (row.rawExchange || null);
        if (
          nextName !== targetInstrument.name ||
          nextExchange !== targetInstrument.exchangeCode
        ) {
          const [updatedInstr] = await txDatabase
            .update(instrument)
            .set({
              name: nextName,
              exchangeCode: nextExchange,
            })
            .where(eq(instrument.id, targetInstrument.id))
            .returning();
          if (updatedInstr) {
            targetInstrument = updatedInstr;
            instrumentBySymbol.set(row.symbol, updatedInstr);
          }
        }
      }

      // Ensure PortfolioInstrument link exists in exact CSV symbol group order
      const piKey = `${targetPortfolio.id}::${targetInstrument.id}`;
      if (!existingPiKeys.has(piKey)) {
        const sortOrder = nextPiSortOrder.get(targetPortfolio.id) ?? 0;
        await txDatabase.insert(portfolioInstrument).values({
          portfolioId: targetPortfolio.id,
          instrumentId: targetInstrument.id,
          sortOrder,
          createdByImportId: importLog.id,
        });
        existingPiKeys.add(piKey);
        nextPiSortOrder.set(targetPortfolio.id, sortOrder + 1);
        instrumentsTracked += 1;
      }

      if (row.kind === "placeholder") {
        continue;
      }

      sgdReconcilePairs.set(piKey, {
        portfolioId: targetPortfolio.id,
        instrumentId: targetInstrument.id,
        symbol: row.symbol,
      });

      if (input.duplicateMode === "skip") {
        const hashKey = `${row.portfolio}::${row.dedupeHash}`;
        const existingCount = remainingExistingHashes.get(hashKey) ?? 0;
        if (existingCount > 0) {
          remainingExistingHashes.set(hashKey, existingCount - 1);
          skippedDuplicates += 1;
          continue;
        }
      }

      const sgdSnapshot = buildSgdSnapshotForImportedRow({
        type: row.type,
        currency: row.currency,
        quantity: row.quantity,
        price: row.price,
        executedAt: row.executedAt,
        purchaseFxRate: row.purchaseFxRate,
        purchaseFxCurrencies: row.purchaseFxCurrencies,
      });

      await txDatabase.insert(transaction).values({
        portfolioId: targetPortfolio.id,
        instrumentId: targetInstrument.id,
        type: row.type,
        quantity: row.quantity,
        price: row.price,
        commissionRaw: row.commissionRaw,
        commissionValue: row.commissionValue,
        commissionIsPercent: row.commissionIsPercent,
        executedAt: row.executedAt,
        originalOffset: row.originalOffset,
        currency: row.currency,
        purchaseFxRate: row.purchaseFxRate,
        purchaseFxCurrencies: row.purchaseFxCurrencies,
        fxRateToSgd: sgdSnapshot.fxRateToSgd,
        fxAsOf: sgdSnapshot.fxAsOf,
        fxSource: sgdSnapshot.fxSource,
        totalCostSgd: sgdSnapshot.totalCostSgd,
        accountingMethod: row.accounting,
        accountingExecutionIds: row.accountingExecutionIds,
        notes: row.notes,
        outgoingCashLink: row.outgoingCashLink,
        sourceRowId: row.sourceRowId,
        importId: importLog.id,
        dedupeHash: row.dedupeHash,
      });

      transactionsImported += 1;
      affectedLedgers.set(piKey, {
        portfolioId: targetPortfolio.id,
        instrumentId: targetInstrument.id,
        symbol: row.symbol,
      });
    }

    // Verify full chronological FIFO invariants across every modified ledger
    for (const pair of affectedLedgers.values()) {
      await assertDbPairFifoValid({
        database: txDatabase,
        portfolioId: pair.portfolioId,
        instrumentId: pair.instrumentId,
        symbol: pair.symbol,
        dividendMode: appSettings.dividendMode,
      });
    }

    // Populate historical USD -> SGD rates and exact SGD totals (including
    // FIFO-resolved share counts on Sell All rows and any skipped duplicates).
    await reconcileLedgerPairsSgdTotals({
      pairs: [...sgdReconcilePairs.values()],
      database: txDatabase,
      dividendMode: appSettings.dividendMode,
      fxBook: historicalFx.fxBook,
      sourceByDate: historicalFx.sourceByDate,
    });

    const finalWarnings: CsvWarningItem[] = [...validation.warnings];
    if (historicalFx.fetchFailed && candidateUsdDates.length > 0) {
      finalWarnings.push({
        kind: "missing_fx",
        message:
          "Historical USD → SGD exchange rates could not be reached during import; SGD totals will auto-calculate once online.",
      });
    }

    const rowCounts: CsvImportRowCounts = {
      rowsRead: doc.rows.length,
      validRows: validation.validRows.length,
      portfoliosCreated,
      instrumentsTracked,
      transactionsImported,
      skippedDuplicates,
      rejectedRows: validation.rejectedRows.length,
    };

    await txDatabase
      .update(csvImportLog)
      .set({ rowCounts, warnings: finalWarnings })
      .where(eq(csvImportLog.id, importLog.id));

    // Post-import non-blocking symbol resolution summary (Section 7.5)
    const unresolvedSymbols: CsvSymbolResolutionItem[] = [];
    for (const [sym, pNames] of portfoliosPerSymbol.entries()) {
      const instr = instrumentBySymbol.get(sym);
      if (!instr) {
        continue;
      }
      if (instr.assetType === "crypto") {
        unresolvedSymbols.push({
          symbol: sym,
          portfolioNames: [...pNames],
          status: "unpriced_crypto",
          message:
            'Crypto live pricing is disabled. Displayed as "price unavailable" unless a manual price or worthless flag is set.',
        });
      } else if (!instr.exchangeCode) {
        unresolvedSymbols.push({
          symbol: sym,
          portfolioNames: [...pNames],
          status: "missing_exchange",
          message:
            "Imported without an exchange code (possibly delisted or acquired). Set a manual price if live quotes are unavailable.",
        });
      }
    }

    return {
      importId: importLog.id,
      filename: cleanFilename,
      duplicateMode: input.duplicateMode,
      rowCounts,
      warnings: finalWarnings,
      unresolvedSymbols,
    };
  });
}

// ---------------------------------------------------------------------------
// 3. Undo CSV Import (atomic rollback)
// ---------------------------------------------------------------------------

export async function undoCsvImport(
  importId: string,
  db?: Database,
): Promise<{ importId: string; status: "undone"; undoneAt: string }> {
  const database = db ?? (await getDb());

  return database.transaction(async (txDb) => {
    const txDatabase = txDb as unknown as Database;

    const logs = await txDatabase
      .select()
      .from(csvImportLog)
      .where(eq(csvImportLog.id, importId))
      .limit(1);

    const logEntry = logs[0];
    if (!logEntry) {
      throw new LedgerUserError("Import log entry was not found.", 404);
    }
    if (logEntry.status === "undone") {
      throw new LedgerUserError("This import has already been undone.", 409);
    }

    const appSettings = await getOrCreateSettings(txDatabase);

    // 1. Delete transactions created by this import
    const deletedTransactions = await txDatabase
      .delete(transaction)
      .where(eq(transaction.importId, importId))
      .returning({
        portfolioId: transaction.portfolioId,
        instrumentId: transaction.instrumentId,
      });

    // 2. Remove portfolio_instrument links created by this import if no
    //    transactions remain for that (portfolio, instrument) pair
    const candidatePiRows = await txDatabase
      .select()
      .from(portfolioInstrument)
      .where(eq(portfolioInstrument.createdByImportId, importId));

    for (const pi of candidatePiRows) {
      const remainingTx = await txDatabase
        .select({ id: transaction.id })
        .from(transaction)
        .where(
          and(
            eq(transaction.portfolioId, pi.portfolioId),
            eq(transaction.instrumentId, pi.instrumentId),
          ),
        )
        .limit(1);

      if (remainingTx.length === 0) {
        await txDatabase
          .delete(portfolioInstrument)
          .where(
            and(
              eq(portfolioInstrument.portfolioId, pi.portfolioId),
              eq(portfolioInstrument.instrumentId, pi.instrumentId),
            ),
          );
      }
    }

    // 3. Remove portfolios created by this import if now completely empty
    const candidatePortfolios = await txDatabase
      .select()
      .from(portfolio)
      .where(eq(portfolio.createdByImportId, importId));

    for (const p of candidatePortfolios) {
      const [remainingPi, remainingTx] = await Promise.all([
        txDatabase
          .select({ instrumentId: portfolioInstrument.instrumentId })
          .from(portfolioInstrument)
          .where(eq(portfolioInstrument.portfolioId, p.id))
          .limit(1),
        txDatabase
          .select({ id: transaction.id })
          .from(transaction)
          .where(eq(transaction.portfolioId, p.id))
          .limit(1),
      ]);

      if (remainingPi.length === 0 && remainingTx.length === 0) {
        await txDatabase.delete(portfolio).where(eq(portfolio.id, p.id));
      }
    }

    // 4. Clean up orphan instruments that are no longer referenced anywhere
    const allInstruments = await txDatabase.select().from(instrument);
    const symbolByInstrumentId = new Map<string, string>();
    for (const item of allInstruments) {
      symbolByInstrumentId.set(item.id, item.symbol);
    }

    for (const item of allInstruments) {
      const [refPi, refTx, refAction, refBar] = await Promise.all([
        txDatabase
          .select({ portfolioId: portfolioInstrument.portfolioId })
          .from(portfolioInstrument)
          .where(eq(portfolioInstrument.instrumentId, item.id))
          .limit(1),
        txDatabase
          .select({ id: transaction.id })
          .from(transaction)
          .where(eq(transaction.instrumentId, item.id))
          .limit(1),
        txDatabase
          .select({ id: corporateAction.id })
          .from(corporateAction)
          .where(eq(corporateAction.instrumentId, item.id))
          .limit(1),
        txDatabase
          .select({ date: priceBar.date })
          .from(priceBar)
          .where(eq(priceBar.instrumentId, item.id))
          .limit(1),
      ]);

      if (
        refPi.length === 0 &&
        refTx.length === 0 &&
        refAction.length === 0 &&
        refBar.length === 0
      ) {
        await txDatabase
          .delete(instrument)
          .where(eq(instrument.id, item.id));
      }
    }

    // 5. Ensure any remaining ledgers affected by removed Buys are still valid
    const checkedPairs = new Set<string>();
    for (const item of deletedTransactions) {
      const key = `${item.portfolioId}::${item.instrumentId}`;
      if (checkedPairs.has(key)) {
        continue;
      }
      checkedPairs.add(key);

      await assertDbPairFifoValid({
        database: txDatabase,
        portfolioId: item.portfolioId,
        instrumentId: item.instrumentId,
        symbol: symbolByInstrumentId.get(item.instrumentId) ?? "Unknown",
        dividendMode: appSettings.dividendMode,
      });
    }

    const undoneAt = new Date();
    await txDatabase
      .update(csvImportLog)
      .set({
        status: "undone",
        undoneAt,
      })
      .where(eq(csvImportLog.id, importId));

    return {
      importId,
      status: "undone",
      undoneAt: undoneAt.toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------
// 4. Import History Listing
// ---------------------------------------------------------------------------

export async function listCsvImportLogs(
  db?: Database,
): Promise<CsvImportLogEntry[]> {
  const database = db ?? (await getDb());
  const rows = await database
    .select()
    .from(csvImportLog)
    .orderBy(desc(csvImportLog.createdAt));

  return rows.map((row) => ({
    id: row.id,
    filename: row.filename,
    status: row.status,
    rowCounts: (row.rowCounts ?? {}) as Partial<CsvImportRowCounts>,
    warnings: Array.isArray(row.warnings)
      ? (row.warnings as CsvWarningItem[])
      : [],
    createdAt: new Date(row.createdAt).toISOString(),
    undoneAt: row.undoneAt ? new Date(row.undoneAt).toISOString() : null,
  }));
}

// ---------------------------------------------------------------------------
// 5. Lossless MSP CSV Export, Clean CSV Export, Template & Full JSON Backup
// ---------------------------------------------------------------------------

function currentSgtDateString(): string {
  return formatInstantInOffset(new Date(), "+0800").localDate;
}

export async function exportMspCsvFromDb(
  options: { portfolioId?: string } = {},
  db?: Database,
): Promise<{ filename: string; content: string }> {
  const database = db ?? (await getDb());

  const allPortfolios = await listPortfolios(database);
  const targetPortfolios = options.portfolioId
    ? allPortfolios.filter((p) => p.id === options.portfolioId)
    : allPortfolios;

  if (options.portfolioId && targetPortfolios.length === 0) {
    throw new LedgerUserError("Selected portfolio was not found.", 404);
  }

  const [piRows, txRows] = await Promise.all([
    database
      .select({
        pi: portfolioInstrument,
        instr: instrument,
      })
      .from(portfolioInstrument)
      .innerJoin(
        instrument,
        eq(portfolioInstrument.instrumentId, instrument.id),
      )
      .orderBy(
        asc(portfolioInstrument.sortOrder),
        asc(portfolioInstrument.createdAt),
      ),
    database
      .select({
        tx: transaction,
        instr: instrument,
      })
      .from(transaction)
      .innerJoin(instrument, eq(transaction.instrumentId, instrument.id))
      .orderBy(
        asc(transaction.executedAt),
        asc(transaction.sourceRowId),
        asc(transaction.createdAt),
      ),
  ]);

  // Index transactions by (portfolioId::instrumentId)
  const txByPair = new Map<string, typeof txRows>();
  for (const row of txRows) {
    const key = `${row.tx.portfolioId}::${row.tx.instrumentId}`;
    const list = txByPair.get(key) ?? [];
    list.push(row);
    txByPair.set(key, list);
  }

  // Index tracked instruments per portfolio in exact sortOrder
  const piByPortfolio = new Map<string, Instrument[]>();
  for (const row of piRows) {
    const list = piByPortfolio.get(row.pi.portfolioId) ?? [];
    list.push(row.instr);
    piByPortfolio.set(row.pi.portfolioId, list);
  }

  const groups: MspExportSymbolGroup[] = [];

  for (const p of targetPortfolios) {
    const orderedInstruments = [...(piByPortfolio.get(p.id) ?? [])];
    const seenInstrumentIds = new Set(orderedInstruments.map((i) => i.id));

    // Include any instrument with transactions even if missing a portfolio_instrument row
    for (const row of txRows) {
      if (
        row.tx.portfolioId === p.id &&
        !seenInstrumentIds.has(row.instr.id)
      ) {
        seenInstrumentIds.add(row.instr.id);
        orderedInstruments.push(row.instr);
      }
    }

    for (const instr of orderedInstruments) {
      const pairKey = `${p.id}::${instr.id}`;
      const pairTransactions = txByPair.get(pairKey) ?? [];

      const mappedTransactions: MspExportTransactionItem[] =
        pairTransactions.map(({ tx }) => ({
          type: tx.type,
          currency: tx.currency,
          quantity: tx.quantity,
          price: tx.price,
          commissionRaw: tx.commissionRaw,
          executedAt: new Date(tx.executedAt),
          originalOffset: tx.originalOffset,
          purchaseFxRate: tx.purchaseFxRate,
          purchaseFxCurrencies: tx.purchaseFxCurrencies,
          accountingMethod: tx.accountingMethod,
          accountingExecutionIds: tx.accountingExecutionIds,
          notes: tx.notes,
          outgoingCashLink: tx.outgoingCashLink,
        }));

      groups.push({
        portfolioName: p.name,
        symbol: instr.symbol,
        // `importName` is `""` when the original CSV had an empty Name (e.g. HIBB)
        // and `null` only for symbols created manually in Folio.
        name: instr.importName !== null ? instr.importName : (instr.name ?? ""),
        displaySymbol:
          instr.importDisplaySymbol !== null ? instr.importDisplaySymbol : "",
        exchange: instr.exchangeCode ?? "",
        currency: instr.currency,
        transactions: mappedTransactions,
      });
    }
  }

  const sgtToday = currentSgtDateString();
  return {
    filename: `MSP-Portfolios-${sgtToday}.csv`,
    content: writeMspCsv(groups),
  };
}

export async function exportCleanCsvFromDb(
  options: { portfolioId?: string } = {},
  db?: Database,
): Promise<{ filename: string; content: string }> {
  const database = db ?? (await getDb());

  if (options.portfolioId) {
    const existing = await database
      .select({ id: portfolio.id })
      .from(portfolio)
      .where(eq(portfolio.id, options.portfolioId))
      .limit(1);
    if (existing.length === 0) {
      throw new LedgerUserError("Selected portfolio was not found.", 404);
    }
  }

  const enrichedDescending = await listEnrichedTransactions(
    { portfolioId: options.portfolioId },
    database,
  );
  // Export chronologically from oldest to newest
  const chronological = [...enrichedDescending].reverse();

  const cleanRows: CleanCsvRowInput[] = chronological.map((row) => ({
    id: row.id,
    portfolioName: row.portfolioName,
    symbol: row.symbol,
    instrumentName: row.instrumentName,
    exchangeCode: row.exchangeCode,
    type: row.type,
    currency: row.currency,
    quantity: row.quantity,
    price: row.price,
    commissionRaw: row.commissionRaw,
    executedAtIso: row.executedAt,
    localDate: row.localDate,
    localTime: row.localTime,
    fxRateToSgd: row.fxRateToSgd,
    fxSource: row.fxSource,
    totalCostSgd: row.totalCostSgd,
    isManualPrice: row.isManualPrice,
    isManualFxRate: row.isManualFxRate,
    notes: row.notes,
  }));

  const sgtToday = currentSgtDateString();
  return {
    filename: `Kestrel-Transactions-${sgtToday}.csv`,
    content: writeCleanCsv(cleanRows),
  };
}

export function exportPlainTemplateCsv(): {
  filename: string;
  content: string;
} {
  return {
    filename: "Kestrel-Import-Template.csv",
    content: generatePlainCsvTemplate(),
  };
}

export async function exportFullBackupJson(
  db?: Database,
): Promise<{ filename: string; content: string }> {
  const database = db ?? (await getDb());

  const [
    appSettings,
    portfolios,
    instruments,
    portfolioInstruments,
    transactions,
    corporateActions,
    importLogs,
    mspExport,
  ] = await Promise.all([
    getOrCreateSettings(database),
    listPortfolios(database),
    database.select().from(instrument).orderBy(asc(instrument.symbol)),
    database
      .select()
      .from(portfolioInstrument)
      .orderBy(
        asc(portfolioInstrument.portfolioId),
        asc(portfolioInstrument.sortOrder),
      ),
    database
      .select()
      .from(transaction)
      .orderBy(asc(transaction.executedAt), asc(transaction.sourceRowId)),
    database
      .select()
      .from(corporateAction)
      .orderBy(asc(corporateAction.exDate)),
    listCsvImportLogs(database),
    exportMspCsvFromDb({}, database),
  ]);

  const payload = {
    schemaVersion: 1,
    app: "Kestrel",
    exportedAt: new Date().toISOString(),
    timezone: "Asia/Singapore",
    settings: appSettings,
    portfolios,
    instruments,
    portfolioInstruments,
    transactions,
    corporateActions,
    importLogs,
    mspCsv: mspExport.content,
  };

  const sgtToday = currentSgtDateString();
  return {
    filename: `Kestrel-Backup-${sgtToday}.json`,
    content: `${JSON.stringify(payload, null, 2)}\n`,
  };
}

