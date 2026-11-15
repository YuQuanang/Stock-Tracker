/**
 * Server-side Ledger Service.
 *
 * Manages Settings, Portfolios, Instruments, Corporate Splits, and the
 * Transaction Ledger, enforcing FIFO chronological invariants inside database
 * transactions so no create, edit, or delete can leave an oversold ledger.
 *
 * Every function accepts an optional `Database` handle (defaulting to `getDb()`)
 * so unit and integration tests can run against an isolated in-memory PGlite
 * instance.
 */
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { type Database, getDb } from "@/db/client";
import {
  corporateAction,
  fxRate,
  instrument,
  type Instrument,
  portfolio,
  type Portfolio,
  portfolioInstrument,
  priceBar,
  settings,
  type Settings,
  transaction,
  type Transaction,
} from "@/db/schema";
import {
  applySymbolWideSellAll,
  computeTransactionDedupeHash,
  evaluateFifoLedger,
  type FifoEvaluationResult,
  FifoValidationError,
  formatInstantInOffset,
  FxRateBook,
  type LedgerTransactionInput,
  parseCommissionInput,
  parseDateAndTimeWithOffset,
  type SplitAction,
  toDecimal,
  toDecimalString,
  toNullableDecimalString,
  ZERO,
} from "@/lib/finance";
import { getSgxTickerTransition } from "@/lib/market-data/sgx-transitions";
import { type AssetClass, inferInstrumentMetadata } from "@/lib/symbols";
import { reconcileLedgerPairsSgdTotals } from "@/lib/services/fx-sgd";
import { evaluateInstrumentAcrossPortfolios } from "@/lib/services/symbol-ledgers";

export class LedgerUserError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode: number = 422) {
    super(message);
    this.name = "LedgerUserError";
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Returns the single settings row, creating it with defaults on first run. */
export async function getOrCreateSettings(db?: Database): Promise<Settings> {
  const database = db ?? (await getDb());
  const existing = await database
    .select()
    .from(settings)
    .where(eq(settings.id, 1))
    .limit(1);

  if (existing[0]) {
    return existing[0];
  }

  const inserted = await database
    .insert(settings)
    .values({ id: 1 })
    .onConflictDoNothing()
    .returning();

  if (inserted[0]) {
    return inserted[0];
  }

  const retry = await database
    .select()
    .from(settings)
    .where(eq(settings.id, 1))
    .limit(1);
  return retry[0];
}

// ---------------------------------------------------------------------------
// Portfolios
// ---------------------------------------------------------------------------

export async function listPortfolios(db?: Database): Promise<Portfolio[]> {
  const database = db ?? (await getDb());
  return database
    .select()
    .from(portfolio)
    .orderBy(asc(portfolio.sortOrder), asc(portfolio.createdAt));
}

export interface CreatePortfolioInput {
  name: string;
  type?: "holdings" | "watchlist";
  defaultCurrency?: "USD" | "SGD";
}

export async function createPortfolio(
  input: CreatePortfolioInput,
  db?: Database,
): Promise<Portfolio> {
  const database = db ?? (await getDb());
  const trimmedName = input.name.trim();
  if (!trimmedName) {
    throw new LedgerUserError("Portfolio name cannot be empty.", 400);
  }

  const existing = await database
    .select({ id: portfolio.id })
    .from(portfolio)
    .where(eq(portfolio.name, trimmedName))
    .limit(1);

  if (existing.length > 0) {
    throw new LedgerUserError(
      `A portfolio named "${trimmedName}" already exists.`,
      409,
    );
  }

  const currentPortfolios = await listPortfolios(database);
  const nextSortOrder =
    currentPortfolios.length === 0
      ? 0
      : Math.max(...currentPortfolios.map((item) => item.sortOrder)) + 1;

  const [created] = await database
    .insert(portfolio)
    .values({
      name: trimmedName,
      type: input.type ?? "holdings",
      defaultCurrency: input.defaultCurrency ?? "USD",
      sortOrder: nextSortOrder,
    })
    .returning();

  return created;
}

export async function updatePortfolio(
  id: string,
  patch: {
    name?: string;
    defaultCurrency?: "USD" | "SGD";
    sortOrder?: number;
  },
  db?: Database,
): Promise<Portfolio> {
  const database = db ?? (await getDb());
  const updates: Partial<typeof portfolio.$inferInsert> = {};

  if (patch.name !== undefined) {
    const trimmed = patch.name.trim();
    if (!trimmed) {
      throw new LedgerUserError("Portfolio name cannot be empty.", 400);
    }

    const duplicate = await database
      .select({ id: portfolio.id })
      .from(portfolio)
      .where(and(eq(portfolio.name, trimmed), ne(portfolio.id, id)))
      .limit(1);

    if (duplicate.length > 0) {
      throw new LedgerUserError(
        `A portfolio named "${trimmed}" already exists.`,
        409,
      );
    }

    updates.name = trimmed;
  }
  if (patch.defaultCurrency !== undefined) {
    updates.defaultCurrency = patch.defaultCurrency;
  }
  if (patch.sortOrder !== undefined) {
    updates.sortOrder = patch.sortOrder;
  }

  if (Object.keys(updates).length === 0) {
    const [existing] = await database
      .select()
      .from(portfolio)
      .where(eq(portfolio.id, id))
      .limit(1);

    if (!existing) {
      throw new LedgerUserError("Portfolio not found.", 404);
    }
    return existing;
  }

  const [updated] = await database
    .update(portfolio)
    .set(updates)
    .where(eq(portfolio.id, id))
    .returning();

  if (!updated) {
    throw new LedgerUserError("Portfolio not found.", 404);
  }
  return updated;
}

export async function deletePortfolio(
  id: string,
  db?: Database,
): Promise<void> {
  const database = db ?? (await getDb());
  const deleted = await database
    .delete(portfolio)
    .where(eq(portfolio.id, id))
    .returning({ id: portfolio.id });

  if (deleted.length === 0) {
    throw new LedgerUserError("Portfolio not found.", 404);
  }
}

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

export interface UpsertInstrumentInput {
  symbol: string;
  name?: string | null;
  exchangeCode?: string | null;
  currency?: string | null;
  assetType?: AssetClass | null;
}

export async function findOrCreateInstrument(
  input: UpsertInstrumentInput,
  db?: Database,
): Promise<Instrument> {
  const database = db ?? (await getDb());
  const inferred = inferInstrumentMetadata(input);

  if (!inferred.symbol) {
    throw new LedgerUserError("Symbol cannot be empty.", 400);
  }

  const existingRows = await database
    .select()
    .from(instrument)
    .where(eq(instrument.symbol, inferred.symbol))
    .limit(1);

  if (existingRows[0]) {
    const found = existingRows[0];
    const incomingName = input.name?.trim() || null;
    const incomingExchange = input.exchangeCode?.trim() || inferred.exchangeCode;
    // Update display name or exchange code when supplied from live search
    // (preserving `importName` untouched for lossless CSV round-tripping).
    const nextName = incomingName ?? found.name;
    const nextExchange =
      (input.exchangeCode?.trim() || found.exchangeCode || incomingExchange) ??
      null;
    if (nextName !== found.name || nextExchange !== found.exchangeCode) {
      const [enriched] = await database
        .update(instrument)
        .set({
          name: nextName,
          exchangeCode: nextExchange,
        })
        .where(eq(instrument.id, found.id))
        .returning();
      return enriched ?? found;
    }
    return found;
  }

  const cleanName = input.name?.trim() || null;
  const [created] = await database
    .insert(instrument)
    .values({
      symbol: inferred.symbol,
      name: cleanName,
      exchangeCode: inferred.exchangeCode,
      currency: inferred.currency,
      assetType: inferred.assetType,
    })
    .returning();

  return created;
}

export async function listInstruments(db?: Database): Promise<Instrument[]> {
  const database = db ?? (await getDb());
  return database.select().from(instrument).orderBy(asc(instrument.symbol));
}

export async function updateInstrumentOverrides(
  id: string,
  patch: {
    name?: string | null;
    manualPrice?: string | number | null;
    isDelisted?: boolean;
  },
  db?: Database,
): Promise<Instrument> {
  const database = db ?? (await getDb());
  const updates: Partial<typeof instrument.$inferInsert> = {};

  if (patch.name !== undefined) {
    updates.name = patch.name === null ? null : patch.name.trim() || null;
  }
  if (patch.manualPrice !== undefined) {
    if (patch.manualPrice === null || String(patch.manualPrice).trim() === "") {
      updates.manualPrice = null;
    } else {
      const parsed = toDecimal(patch.manualPrice);
      if (parsed.isNegative()) {
        throw new LedgerUserError("Manual price cannot be negative.", 400);
      }
      updates.manualPrice = toDecimalString(parsed, 12);
    }
  }
  if (patch.isDelisted !== undefined) {
    updates.isDelisted = patch.isDelisted;
  }

  const [updated] = await database
    .update(instrument)
    .set(updates)
    .where(eq(instrument.id, id))
    .returning();

  if (!updated) {
    throw new LedgerUserError("Instrument not found.", 404);
  }
  return updated;
}

export async function migrateInstrumentSymbol(
  instrumentId: string,
  input: {
    targetSymbol: string;
    targetName?: string | null;
    applyConsolidationSplit?: boolean;
    exDate?: string;
    ratioNumerator?: number;
    ratioDenominator?: number;
  },
  db?: Database,
): Promise<{
  instrument: Instrument;
  previousSymbol: string;
  appliedSplit: boolean;
}> {
  const database = db ?? (await getDb());
  const appSettings = await getOrCreateSettings(database);
  const targetSymbol = input.targetSymbol.trim().toUpperCase();

  if (!targetSymbol) {
    throw new LedgerUserError("Replacement ticker symbol cannot be empty.", 400);
  }

  return database.transaction(async (txDb) => {
    const txDatabase = txDb as unknown as Database;

    const [sourceInstr] = await txDatabase
      .select()
      .from(instrument)
      .where(eq(instrument.id, instrumentId))
      .limit(1);

    if (!sourceInstr) {
      throw new LedgerUserError("Instrument not found.", 404);
    }

    const previousSymbol = sourceInstr.symbol;
    if (previousSymbol.toUpperCase() === targetSymbol) {
      throw new LedgerUserError(
        `Instrument is already set to ${targetSymbol}.`,
        400,
      );
    }

    const transition = getSgxTickerTransition(previousSymbol);
    const applySplitRequested = Boolean(input.applyConsolidationSplit);
    const splitExDate =
      input.exDate?.trim() || transition?.effectiveDate || "";
    const splitNum = input.ratioNumerator ?? transition?.ratioNumerator ?? 0;
    const splitDen =
      input.ratioDenominator ?? transition?.ratioDenominator ?? 0;

    if (applySplitRequested) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(splitExDate)) {
        throw new LedgerUserError(
          "Consolidation ex-date must be formatted as YYYY-MM-DD.",
          400,
        );
      }
      if (
        !Number.isInteger(splitNum) ||
        !Number.isInteger(splitDen) ||
        splitNum <= 0 ||
        splitDen <= 0
      ) {
        throw new LedgerUserError(
          "Consolidation ratio numbers must be positive whole numbers.",
          400,
        );
      }
    }

    const inferred = inferInstrumentMetadata({
      symbol: targetSymbol,
      name:
        input.targetName?.trim() ||
        transition?.companyName ||
        sourceInstr.name,
    });

    const [existingTarget] = await txDatabase
      .select()
      .from(instrument)
      .where(eq(instrument.symbol, targetSymbol))
      .limit(1);

    let destination: Instrument;

    // Clear stale retired-counter daily bars so charts & quotes reload clean data
    // for the replacement ticker without mixing pre-transition bars.
    await txDatabase
      .delete(priceBar)
      .where(eq(priceBar.instrumentId, sourceInstr.id));

    if (!existingTarget) {
      const nextName =
        input.targetName?.trim() ||
        transition?.companyName ||
        sourceInstr.name;
      const [renamed] = await txDatabase
        .update(instrument)
        .set({
          symbol: targetSymbol,
          name: nextName,
          exchangeCode: inferred.exchangeCode ?? sourceInstr.exchangeCode,
          currency: inferred.currency,
          assetType:
            inferred.assetType === "unknown"
              ? sourceInstr.assetType
              : inferred.assetType,
          manualPrice: null,
          priceNotFoundAt: null,
          priceNotFoundReason: null,
        })
        .where(eq(instrument.id, sourceInstr.id))
        .returning();

      destination = renamed;
    } else {
      await txDatabase
        .update(transaction)
        .set({ instrumentId: existingTarget.id, updatedAt: new Date() })
        .where(eq(transaction.instrumentId, sourceInstr.id));

      const sourceLinks = await txDatabase
        .select()
        .from(portfolioInstrument)
        .where(eq(portfolioInstrument.instrumentId, sourceInstr.id));

      const targetLinks = await txDatabase
        .select()
        .from(portfolioInstrument)
        .where(eq(portfolioInstrument.instrumentId, existingTarget.id));

      const targetByPortfolio = new Map(
        targetLinks.map((link) => [link.portfolioId, link]),
      );

      for (const link of sourceLinks) {
        const existingLink = targetByPortfolio.get(link.portfolioId);
        if (!existingLink) {
          await txDatabase
            .update(portfolioInstrument)
            .set({ instrumentId: existingTarget.id })
            .where(
              and(
                eq(portfolioInstrument.portfolioId, link.portfolioId),
                eq(portfolioInstrument.instrumentId, sourceInstr.id),
              ),
            );
        } else {
          await txDatabase
            .update(portfolioInstrument)
            .set({
              priceWhenAdded:
                existingLink.priceWhenAdded ?? link.priceWhenAdded,
              alertAbove: existingLink.alertAbove ?? link.alertAbove,
              alertBelow: existingLink.alertBelow ?? link.alertBelow,
              paperEntryDate:
                existingLink.paperEntryDate ?? link.paperEntryDate,
              paperAmount: existingLink.paperAmount ?? link.paperAmount,
              paperShares: existingLink.paperShares ?? link.paperShares,
            })
            .where(
              and(
                eq(portfolioInstrument.portfolioId, existingLink.portfolioId),
                eq(portfolioInstrument.instrumentId, existingTarget.id),
              ),
            );
          await txDatabase
            .delete(portfolioInstrument)
            .where(
              and(
                eq(portfolioInstrument.portfolioId, link.portfolioId),
                eq(portfolioInstrument.instrumentId, sourceInstr.id),
              ),
            );
        }
      }

      const sourceActions = await txDatabase
        .select()
        .from(corporateAction)
        .where(eq(corporateAction.instrumentId, sourceInstr.id));
      const existingActions = await txDatabase
        .select()
        .from(corporateAction)
        .where(eq(corporateAction.instrumentId, existingTarget.id));

      const actionKeys = new Set(
        existingActions.map(
          (a) => `${a.exDate}|${a.ratioNumerator}|${a.ratioDenominator}`,
        ),
      );

      for (const action of sourceActions) {
        const key = `${action.exDate}|${action.ratioNumerator}|${action.ratioDenominator}`;
        if (!actionKeys.has(key)) {
          await txDatabase
            .update(corporateAction)
            .set({ instrumentId: existingTarget.id })
            .where(eq(corporateAction.id, action.id));
          actionKeys.add(key);
        }
      }

      const [updatedTarget] = await txDatabase
        .update(instrument)
        .set({
          name:
            existingTarget.name ??
            input.targetName?.trim() ??
            transition?.companyName ??
            sourceInstr.name,
          priceNotFoundAt: null,
          priceNotFoundReason: null,
        })
        .where(eq(instrument.id, existingTarget.id))
        .returning();

      await txDatabase
        .delete(instrument)
        .where(eq(instrument.id, sourceInstr.id));

      destination = updatedTarget ?? existingTarget;
    }

    let appliedSplit = false;
    if (applySplitRequested) {
      const existingSplits = await txDatabase
        .select()
        .from(corporateAction)
        .where(eq(corporateAction.instrumentId, destination.id));

      const hasMatchingSplit = existingSplits.some(
        (s) =>
          s.exDate === splitExDate &&
          s.ratioNumerator === splitNum &&
          s.ratioDenominator === splitDen,
      );

      if (!hasMatchingSplit) {
        await txDatabase.insert(corporateAction).values({
          instrumentId: destination.id,
          exDate: splitExDate,
          type: "split",
          ratioNumerator: splitNum,
          ratioDenominator: splitDen,
        });
        appliedSplit = true;
      }
    }

    const affectedPortfolios = await txDatabase
      .selectDistinct({ portfolioId: transaction.portfolioId })
      .from(transaction)
      .where(eq(transaction.instrumentId, destination.id));

    if (affectedPortfolios.length > 0) {
      await assertInstrumentLedgerValid({
        database: txDatabase,
        portfolioId: affectedPortfolios[0].portfolioId,
        instrumentId: destination.id,
        symbol: destination.symbol,
        dividendMode: appSettings.dividendMode,
      });
    }

    return {
      instrument: destination,
      previousSymbol,
      appliedSplit,
    };
  });
}

// ---------------------------------------------------------------------------
// Ledger <-> Finance mapping helpers
// ---------------------------------------------------------------------------

export function mapDbTransactionToFifoInput(
  row: Transaction,
): LedgerTransactionInput {
  return {
    id: row.id,
    type: row.type,
    quantity: row.quantity,
    price: row.price,
    commissionRaw: row.commissionRaw,
    commissionValue: row.commissionValue,
    commissionIsPercent: row.commissionIsPercent,
    executedAt: new Date(row.executedAt),
    originalOffset: row.originalOffset,
    currency: row.currency,
    purchaseFxRate: row.purchaseFxRate,
    purchaseFxCurrencies: row.purchaseFxCurrencies,
    fxRateToSgd: row.fxRateToSgd,
    sourceRowId: row.sourceRowId,
    createdAt: new Date(row.createdAt),
  };
}

/**
 * Verifies that the symbol's ledgers satisfy FIFO chronological invariants (no
 * oversells, no empty Sell All). Because a `Sell All` closes the symbol in every
 * portfolio, ALL portfolios holding the instrument are validated together -
 * an edit in one portfolio can affect another. Throws `LedgerUserError` with a
 * clear human sentence if violated and returns the FIFO result of the requested
 * `portfolioId`.
 */
async function assertInstrumentLedgerValid(params: {
  database: Database;
  portfolioId: string;
  instrumentId: string;
  symbol: string;
  dividendMode: "cash" | "shares";
}): Promise<FifoEvaluationResult> {
  try {
    const evaluations = await evaluateInstrumentAcrossPortfolios({
      database: params.database,
      instrumentId: params.instrumentId,
      symbol: params.symbol,
      dividendMode: params.dividendMode,
      onValidationError: "throw",
    });

    // Keep SGD totals (including Sell All disposed shares after splits/edits)
    // in exact sync across every portfolio of this symbol.
    const cachedFxRows = await params.database.select().from(fxRate);
    const sourceByDate = new Map<string, string>();
    for (const r of cachedFxRows) {
      if (r.fromCurrency === "USD" && r.toCurrency === "SGD") {
        sourceByDate.set(r.date, r.source);
      }
    }

    const portfolioIds = new Set(evaluations.map((e) => e.portfolioId));
    portfolioIds.add(params.portfolioId);

    await reconcileLedgerPairsSgdTotals({
      pairs: [...portfolioIds].map((portfolioId) => ({
        portfolioId,
        instrumentId: params.instrumentId,
        symbol: params.symbol,
      })),
      database: params.database,
      dividendMode: params.dividendMode,
      fxBook: new FxRateBook(cachedFxRows),
      sourceByDate,
    });

    const target = evaluations.find((e) => e.portfolioId === params.portfolioId);
    return (
      target?.fifo ??
      evaluateFifoLedger([], {
        symbol: params.symbol,
        dividendMode: params.dividendMode,
      })
    );
  } catch (error) {
    if (error instanceof FifoValidationError) {
      throw new LedgerUserError(error.message, 422);
    }
    throw error;
  }
}


// ---------------------------------------------------------------------------
// Transactions CRUD
// ---------------------------------------------------------------------------

export interface EnrichedTransactionRow {
  id: string;
  portfolioId: string;
  portfolioName: string;
  instrumentId: string;
  symbol: string;
  instrumentName: string | null;
  exchangeCode: string | null;
  type: "Buy" | "Sell" | "Sell All" | "Dividend";
  quantity: string;
  price: string;
  commissionRaw: string | null;
  commissionValue: string | null;
  commissionIsPercent: boolean;
  executedAt: string;
  localDate: string;
  localTime: string;
  originalOffset: string;
  currency: string;
  purchaseFxRate: string | null;
  purchaseFxCurrencies: string | null;
  priceAsOf: string | null;
  priceStatus: string | null;
  fxRateToSgd: string | null;
  fxAsOf: string | null;
  fxSource: string | null;
  totalCostSgd: string | null;
  isManualPrice: boolean;
  isManualFxRate: boolean;
  notes: string | null;
  sourceRowId: number | null;
}

function mapJoinedTransactionRow(row: {
  tx: Transaction;
  portfolioName: string;
  symbol: string;
  instrumentName: string | null;
  exchangeCode: string | null;
}): EnrichedTransactionRow {
  const { tx, portfolioName, symbol, instrumentName, exchangeCode } = row;
  const instant = new Date(tx.executedAt);
  const formatted = formatInstantInOffset(instant, tx.originalOffset);

  return {
    id: tx.id,
    portfolioId: tx.portfolioId,
    portfolioName,
    instrumentId: tx.instrumentId,
    symbol,
    instrumentName,
    exchangeCode,
    type: tx.type,
    quantity: toDecimalString(toDecimal(tx.quantity), 12),
    price: toDecimalString(toDecimal(tx.price), 12),
    commissionRaw: tx.commissionRaw,
    commissionValue: tx.commissionValue
      ? toDecimalString(toDecimal(tx.commissionValue), 12)
      : null,
    commissionIsPercent: tx.commissionIsPercent,
    executedAt: instant.toISOString(),
    localDate: formatted.localDate,
    localTime: formatted.localTime,
    originalOffset: formatted.offset,
    currency: tx.currency,
    purchaseFxRate: tx.purchaseFxRate
      ? toDecimalString(toDecimal(tx.purchaseFxRate), 10)
      : null,
    purchaseFxCurrencies: tx.purchaseFxCurrencies,
    priceAsOf: tx.priceAsOf ? new Date(tx.priceAsOf).toISOString() : null,
    priceStatus: tx.priceStatus ?? null,
    fxRateToSgd: tx.fxRateToSgd
      ? toDecimalString(toDecimal(tx.fxRateToSgd), 10)
      : null,
    fxAsOf: tx.fxAsOf ? new Date(tx.fxAsOf).toISOString() : null,
    fxSource: tx.fxSource ?? null,
    totalCostSgd: tx.totalCostSgd
      ? toDecimalString(toDecimal(tx.totalCostSgd), 6)
      : null,
    isManualPrice: tx.isManualPrice,
    isManualFxRate: tx.isManualFxRate,
    notes: tx.notes,
    sourceRowId: tx.sourceRowId,
  };
}

export async function listEnrichedTransactions(
  filters: {
    portfolioId?: string;
    instrumentId?: string;
  } = {},
  db?: Database,
): Promise<EnrichedTransactionRow[]> {
  const database = db ?? (await getDb());

  const conditions = [];
  if (filters.portfolioId) {
    conditions.push(eq(transaction.portfolioId, filters.portfolioId));
  }
  if (filters.instrumentId) {
    conditions.push(eq(transaction.instrumentId, filters.instrumentId));
  }

  const rows = await database
    .select({
      tx: transaction,
      portfolioName: portfolio.name,
      symbol: instrument.symbol,
      instrumentName: instrument.name,
      exchangeCode: instrument.exchangeCode,
    })
    .from(transaction)
    .innerJoin(portfolio, eq(transaction.portfolioId, portfolio.id))
    .innerJoin(instrument, eq(transaction.instrumentId, instrument.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(transaction.executedAt), desc(transaction.sourceRowId));

  return rows.map(mapJoinedTransactionRow);
}

export async function getEnrichedTransactionById(
  id: string,
  db?: Database,
): Promise<EnrichedTransactionRow | null> {
  const database = db ?? (await getDb());
  const rows = await database
    .select({
      tx: transaction,
      portfolioName: portfolio.name,
      symbol: instrument.symbol,
      instrumentName: instrument.name,
      exchangeCode: instrument.exchangeCode,
    })
    .from(transaction)
    .innerJoin(portfolio, eq(transaction.portfolioId, portfolio.id))
    .innerJoin(instrument, eq(transaction.instrumentId, instrument.id))
    .where(eq(transaction.id, id))
    .limit(1);

  return rows[0] ? mapJoinedTransactionRow(rows[0]) : null;
}

export interface SaveTransactionInput {
  portfolioId: string;
  symbol: string;
  instrumentName?: string | null;
  exchangeCode?: string | null;
  type: "Buy" | "Sell" | "Sell All" | "Dividend";
  quantity: string | number;
  price: string | number;
  commission?: string | null;
  /** Date as `YYYY-MM-DD` or `YYYY-MM-DD GMT+0800`. */
  date: string;
  /** Time as `HH:MM` or `HH:MM:SS` (default `00:00:00`). */
  time?: string | null;
  /** Offset such as `"+0800"` (default `"+0800"`). */
  offset?: string;
  currency?: "USD" | "SGD";
  purchaseFxRate?: string | number | null;
  purchaseFxCurrencies?: string | null;
  priceAsOf?: string | Date | null;
  priceStatus?: string | null;
  fxRateToSgd?: string | number | null;
  fxAsOf?: string | Date | null;
  fxSource?: string | null;
  isManualPrice?: boolean;
  isManualFxRate?: boolean;
  notes?: string | null;
}

function parseOptionalInstant(
  raw: string | Date | null | undefined,
  fieldLabel: string,
): Date | null {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) {
      throw new LedgerUserError(`Invalid ${fieldLabel} timestamp.`, 400);
    }
    return raw;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new LedgerUserError(`Invalid ${fieldLabel} timestamp.`, 400);
  }
  return parsed;
}

function normalizeAndValidateAmounts(input: SaveTransactionInput) {
  let parsedCommission;
  try {
    parsedCommission = parseCommissionInput(input.commission);
  } catch (error) {
    throw new LedgerUserError(
      error instanceof Error ? error.message : "Invalid commission.",
      400,
    );
  }

  let parsedTimestamp;
  try {
    parsedTimestamp = parseDateAndTimeWithOffset(
      input.date,
      input.time,
      input.offset ?? "+0800",
    );
  } catch (error) {
    throw new LedgerUserError(
      error instanceof Error ? error.message : "Invalid date or time.",
      400,
    );
  }

  const quantity =
    input.type === "Sell All" ? toDecimal(0) : toDecimal(input.quantity);
  const price = toDecimal(input.price);

  if (input.type !== "Sell All" && !quantity.gt(ZERO)) {
    throw new LedgerUserError(
      `${input.type} quantity must be greater than zero.`,
      400,
    );
  }
  if (price.isNegative()) {
    throw new LedgerUserError("Price per share cannot be negative.", 400);
  }

  let purchaseFxDecimal = null;
  if (
    input.purchaseFxRate !== undefined &&
    input.purchaseFxRate !== null &&
    String(input.purchaseFxRate).trim() !== ""
  ) {
    purchaseFxDecimal = toDecimal(input.purchaseFxRate);
    if (!purchaseFxDecimal.gt(ZERO)) {
      throw new LedgerUserError(
        "Purchase exchange rate must be greater than zero.",
        400,
      );
    }
  }

  let snapshotFxDecimal = null;
  if (
    input.fxRateToSgd !== undefined &&
    input.fxRateToSgd !== null &&
    String(input.fxRateToSgd).trim() !== ""
  ) {
    snapshotFxDecimal = toDecimal(input.fxRateToSgd);
    if (!snapshotFxDecimal.gt(ZERO)) {
      throw new LedgerUserError(
        "Exchange rate to SGD must be greater than zero.",
        400,
      );
    }
  }

  const priceAsOf = parseOptionalInstant(input.priceAsOf, "price as-of");
  const fxAsOf = parseOptionalInstant(input.fxAsOf, "exchange rate");

  return {
    parsedCommission,
    parsedTimestamp,
    quantity,
    price,
    purchaseFxDecimal,
    snapshotFxDecimal,
    priceAsOf,
    fxAsOf,
  };
}

function buildSnapshotColumnsForSave(params: {
  input: SaveTransactionInput;
  txCurrency: string;
  quantity: ReturnType<typeof toDecimal>;
  price: ReturnType<typeof toDecimal>;
  executedAt: Date;
  purchaseFxDecimal: ReturnType<typeof toDecimal> | null;
  snapshotFxDecimal: ReturnType<typeof toDecimal> | null;
  priceAsOf: Date | null;
  fxAsOf: Date | null;
}) {
  const isManualPrice = Boolean(params.input.isManualPrice);
  const isManualFxRate = Boolean(params.input.isManualFxRate);
  const isSgd = params.txCurrency === "SGD";

  // Rule 14: Native SGD trades always lock rate = 1 without FX conversion.
  const effectiveFxDecimal = isSgd
    ? toDecimal(1)
    : (params.snapshotFxDecimal ?? params.purchaseFxDecimal);

  const fxRateToSgd = effectiveFxDecimal
    ? toDecimalString(effectiveFxDecimal, 12)
    : null;

  let fxSource = params.input.fxSource?.trim() || null;
  if (isManualFxRate) {
    fxSource = "manual";
  } else if (isSgd && !fxSource) {
    fxSource = "native-sgd";
  }

  const fxAsOf = isSgd
    ? (params.fxAsOf ?? params.executedAt)
    : params.fxAsOf;

  // Sync USD snapshot rate to purchaseFxRate when not separately set so FIFO
  // historical SGD cost basis locks in the exact trade-time rate permanently.
  const effectivePurchaseFxDecimal =
    params.purchaseFxDecimal ?? (!isSgd ? effectiveFxDecimal : null);
  const purchaseFxRate = effectivePurchaseFxDecimal
    ? toDecimalString(effectivePurchaseFxDecimal, 12)
    : null;
  const purchaseFxCurrencies =
    params.input.purchaseFxCurrencies?.trim() ||
    (!isSgd && purchaseFxRate ? "USD/SGD" : null);

  // Rule 14, 19, 20: Compute exact SGD total cost (`quantity * price * rate`)
  // with 40-digit Decimal arithmetic. Never guess when USD rate is missing.
  let totalCostSgd: string | null = null;
  if (effectiveFxDecimal && params.input.type !== "Sell All") {
    const totalDecimal =
      params.input.type === "Dividend"
        ? params.quantity.mul(effectiveFxDecimal)
        : params.quantity.mul(params.price).mul(effectiveFxDecimal);
    totalCostSgd = toDecimalString(totalDecimal, 12);
  }

  const priceStatus = isManualPrice
    ? "manual"
    : params.input.priceStatus?.trim() || null;

  return {
    purchaseFxRate,
    purchaseFxCurrencies,
    priceAsOf: isManualPrice ? null : params.priceAsOf,
    priceStatus,
    fxRateToSgd,
    fxAsOf,
    fxSource,
    totalCostSgd,
    isManualPrice,
    isManualFxRate,
  };
}

export async function createTransaction(
  input: SaveTransactionInput,
  db?: Database,
): Promise<Transaction> {
  const database = db ?? (await getDb());
  const {
    parsedCommission,
    parsedTimestamp,
    quantity,
    price,
    purchaseFxDecimal,
    snapshotFxDecimal,
    priceAsOf,
    fxAsOf,
  } = normalizeAndValidateAmounts(input);
  const appSettings = await getOrCreateSettings(database);

  return database.transaction(async (txDb) => {
    const txDatabase = txDb as unknown as Database;

    const targetPortfolios = await txDatabase
      .select()
      .from(portfolio)
      .where(eq(portfolio.id, input.portfolioId))
      .limit(1);

    const targetPortfolio = targetPortfolios[0];
    if (!targetPortfolio) {
      throw new LedgerUserError("Selected portfolio was not found.", 404);
    }
    if (targetPortfolio.type === "watchlist") {
      throw new LedgerUserError(
        `"${targetPortfolio.name}" is a watchlist. Choose or create a holdings portfolio to record transactions.`,
        422,
      );
    }

    const targetInstrument = await findOrCreateInstrument(
      {
        symbol: input.symbol,
        name: input.instrumentName,
        exchangeCode: input.exchangeCode,
        currency: input.currency,
      },
      txDatabase,
    );

    const txCurrency = input.currency ?? targetInstrument.currency;
    const snapshots = buildSnapshotColumnsForSave({
      input,
      txCurrency,
      quantity,
      price,
      executedAt: parsedTimestamp.executedAt,
      purchaseFxDecimal,
      snapshotFxDecimal,
      priceAsOf,
      fxAsOf,
    });

    // Ensure the symbol is registered as tracked in this portfolio.
    await txDatabase
      .insert(portfolioInstrument)
      .values({
        portfolioId: targetPortfolio.id,
        instrumentId: targetInstrument.id,
      })
      .onConflictDoNothing();

    const dedupeHash = computeTransactionDedupeHash({
      portfolioName: targetPortfolio.name,
      symbol: targetInstrument.symbol,
      type: input.type,
      quantity,
      price,
      executedAt: parsedTimestamp.executedAt,
    });

    const accountingMethod = input.type === "Buy" ? null : "FIFO";

    const [inserted] = await txDatabase
      .insert(transaction)
      .values({
        portfolioId: targetPortfolio.id,
        instrumentId: targetInstrument.id,
        type: input.type,
        quantity: toDecimalString(quantity, 12),
        price: toDecimalString(price, 12),
        commissionRaw: parsedCommission.raw ?? "0",
        commissionValue: toDecimalString(parsedCommission.value, 12),
        commissionIsPercent: parsedCommission.isPercent,
        executedAt: parsedTimestamp.executedAt,
        originalOffset: parsedTimestamp.originalOffset,
        currency: txCurrency,
        purchaseFxRate: snapshots.purchaseFxRate,
        purchaseFxCurrencies: snapshots.purchaseFxCurrencies,
        priceAsOf: snapshots.priceAsOf,
        priceStatus: snapshots.priceStatus,
        fxRateToSgd: snapshots.fxRateToSgd,
        fxAsOf: snapshots.fxAsOf,
        fxSource: snapshots.fxSource,
        totalCostSgd: snapshots.totalCostSgd,
        isManualPrice: snapshots.isManualPrice,
        isManualFxRate: snapshots.isManualFxRate,
        accountingMethod,
        notes: input.notes?.trim() || null,
        dedupeHash,
      })
      .returning();

    // Validate full chronological FIFO invariants; rolls back on oversell.
    await assertInstrumentLedgerValid({
      database: txDatabase,
      portfolioId: targetPortfolio.id,
      instrumentId: targetInstrument.id,
      symbol: targetInstrument.symbol,
      dividendMode: appSettings.dividendMode,
    });

    const [refreshed] = await txDatabase
      .select()
      .from(transaction)
      .where(eq(transaction.id, inserted.id))
      .limit(1);

    return refreshed ?? inserted;
  });
}

export async function updateTransaction(
  id: string,
  input: SaveTransactionInput,
  db?: Database,
): Promise<Transaction> {
  const database = db ?? (await getDb());
  const {
    parsedCommission,
    parsedTimestamp,
    quantity,
    price,
    purchaseFxDecimal,
    snapshotFxDecimal,
    priceAsOf,
    fxAsOf,
  } = normalizeAndValidateAmounts(input);
  const appSettings = await getOrCreateSettings(database);

  return database.transaction(async (txDb) => {
    const txDatabase = txDb as unknown as Database;

    const existingRows = await txDatabase
      .select()
      .from(transaction)
      .where(eq(transaction.id, id))
      .limit(1);

    const existing = existingRows[0];
    if (!existing) {
      throw new LedgerUserError("Transaction not found.", 404);
    }

    const previousInstrRows = await txDatabase
      .select()
      .from(instrument)
      .where(eq(instrument.id, existing.instrumentId))
      .limit(1);

    const targetPortfolios = await txDatabase
      .select()
      .from(portfolio)
      .where(eq(portfolio.id, input.portfolioId))
      .limit(1);

    const targetPortfolio = targetPortfolios[0];
    if (!targetPortfolio) {
      throw new LedgerUserError("Selected portfolio was not found.", 404);
    }
    if (targetPortfolio.type === "watchlist") {
      throw new LedgerUserError(
        `"${targetPortfolio.name}" is a watchlist and cannot hold transactions.`,
        422,
      );
    }

    const targetInstrument = await findOrCreateInstrument(
      {
        symbol: input.symbol,
        name: input.instrumentName,
        exchangeCode: input.exchangeCode,
        currency: input.currency,
      },
      txDatabase,
    );

    await txDatabase
      .insert(portfolioInstrument)
      .values({
        portfolioId: targetPortfolio.id,
        instrumentId: targetInstrument.id,
      })
      .onConflictDoNothing();

    const txCurrency = input.currency ?? targetInstrument.currency;
    const snapshots = buildSnapshotColumnsForSave({
      input,
      txCurrency,
      quantity,
      price,
      executedAt: parsedTimestamp.executedAt,
      purchaseFxDecimal,
      snapshotFxDecimal,
      priceAsOf,
      fxAsOf,
    });

    const dedupeHash = computeTransactionDedupeHash({
      portfolioName: targetPortfolio.name,
      symbol: targetInstrument.symbol,
      type: input.type,
      quantity,
      price,
      executedAt: parsedTimestamp.executedAt,
    });

    const isImportedCsvRow = existing.sourceRowId !== null;
    const preservedPurchaseFxRate =
      isImportedCsvRow && input.purchaseFxRate === undefined
        ? existing.purchaseFxRate
        : snapshots.purchaseFxRate;
    const preservedPurchaseFxCurrencies =
      isImportedCsvRow && input.purchaseFxCurrencies === undefined
        ? existing.purchaseFxCurrencies
        : snapshots.purchaseFxCurrencies;

    const [updated] = await txDatabase
      .update(transaction)
      .set({
        portfolioId: targetPortfolio.id,
        instrumentId: targetInstrument.id,
        type: input.type,
        quantity: toDecimalString(quantity, 12),
        price: toDecimalString(price, 12),
        commissionRaw: parsedCommission.raw ?? "0",
        commissionValue: toDecimalString(parsedCommission.value, 12),
        commissionIsPercent: parsedCommission.isPercent,
        executedAt: parsedTimestamp.executedAt,
        originalOffset: parsedTimestamp.originalOffset,
        currency: txCurrency,
        purchaseFxRate: preservedPurchaseFxRate,
        purchaseFxCurrencies: preservedPurchaseFxCurrencies,
        priceAsOf: snapshots.priceAsOf,
        priceStatus: snapshots.priceStatus,
        fxRateToSgd: snapshots.fxRateToSgd,
        fxAsOf: snapshots.fxAsOf,
        fxSource: snapshots.fxSource,
        totalCostSgd: snapshots.totalCostSgd,
        isManualPrice: snapshots.isManualPrice,
        isManualFxRate: snapshots.isManualFxRate,
        accountingMethod: input.type === "Buy" ? null : "FIFO",
        notes: input.notes?.trim() || null,
        dedupeHash,
        updatedAt: new Date(),
      })
      .where(eq(transaction.id, id))
      .returning();

    // If the edit moved the transaction out of an older (portfolio, instrument),
    // verify the old ledger still holds as well (for example, moving a Buy away
    // must not strand a Sell in the original portfolio).
    const movedAway =
      existing.portfolioId !== targetPortfolio.id ||
      existing.instrumentId !== targetInstrument.id;

    if (movedAway && previousInstrRows[0]) {
      await assertInstrumentLedgerValid({
        database: txDatabase,
        portfolioId: existing.portfolioId,
        instrumentId: existing.instrumentId,
        symbol: previousInstrRows[0].symbol,
        dividendMode: appSettings.dividendMode,
      });
    }

    await assertInstrumentLedgerValid({
      database: txDatabase,
      portfolioId: targetPortfolio.id,
      instrumentId: targetInstrument.id,
      symbol: targetInstrument.symbol,
      dividendMode: appSettings.dividendMode,
    });

    const [refreshed] = await txDatabase
      .select()
      .from(transaction)
      .where(eq(transaction.id, updated.id))
      .limit(1);

    return refreshed ?? updated;
  });
}

export async function deleteTransaction(
  id: string,
  db?: Database,
): Promise<void> {
  const database = db ?? (await getDb());
  const appSettings = await getOrCreateSettings(database);

  await database.transaction(async (txDb) => {
    const txDatabase = txDb as unknown as Database;

    const existingRows = await txDatabase
      .select()
      .from(transaction)
      .where(eq(transaction.id, id))
      .limit(1);

    const existing = existingRows[0];
    if (!existing) {
      throw new LedgerUserError("Transaction not found.", 404);
    }

    const instrRows = await txDatabase
      .select()
      .from(instrument)
      .where(eq(instrument.id, existing.instrumentId))
      .limit(1);

    await txDatabase.delete(transaction).where(eq(transaction.id, id));

    if (instrRows[0]) {
      await assertInstrumentLedgerValid({
        database: txDatabase,
        portfolioId: existing.portfolioId,
        instrumentId: existing.instrumentId,
        symbol: instrRows[0].symbol,
        dividendMode: appSettings.dividendMode,
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Corporate Actions (Stock Splits)
// ---------------------------------------------------------------------------

export interface EnrichedCorporateAction {
  id: string;
  instrumentId: string;
  symbol: string;
  instrumentName: string | null;
  exDate: string;
  ratioNumerator: number;
  ratioDenominator: number;
}

export async function listCorporateActions(
  db?: Database,
): Promise<EnrichedCorporateAction[]> {
  const database = db ?? (await getDb());
  const rows = await database
    .select({
      action: corporateAction,
      symbol: instrument.symbol,
      instrumentName: instrument.name,
    })
    .from(corporateAction)
    .innerJoin(instrument, eq(corporateAction.instrumentId, instrument.id))
    .orderBy(desc(corporateAction.exDate), asc(instrument.symbol));

  return rows.map(({ action, symbol, instrumentName }) => ({
    id: action.id,
    instrumentId: action.instrumentId,
    symbol,
    instrumentName,
    exDate: action.exDate,
    ratioNumerator: action.ratioNumerator,
    ratioDenominator: action.ratioDenominator,
  }));
}

export async function createCorporateSplit(
  input: {
    symbol: string;
    exDate: string;
    ratioNumerator: number;
    ratioDenominator: number;
  },
  db?: Database,
): Promise<EnrichedCorporateAction> {
  const database = db ?? (await getDb());
  const appSettings = await getOrCreateSettings(database);

  if (
    !Number.isInteger(input.ratioNumerator) ||
    !Number.isInteger(input.ratioDenominator) ||
    input.ratioNumerator <= 0 ||
    input.ratioDenominator <= 0
  ) {
    throw new LedgerUserError(
      "Split ratio numbers must be positive whole numbers (for example, 2 for 1).",
      400,
    );
  }

  return database.transaction(async (txDb) => {
    const txDatabase = txDb as unknown as Database;
    const targetInstrument = await findOrCreateInstrument(
      { symbol: input.symbol },
      txDatabase,
    );

    const [created] = await txDatabase
      .insert(corporateAction)
      .values({
        instrumentId: targetInstrument.id,
        exDate: input.exDate,
        type: "split",
        ratioNumerator: input.ratioNumerator,
        ratioDenominator: input.ratioDenominator,
      })
      .returning();

    // Verify every portfolio holding this symbol still satisfies FIFO after the split.
    const affectedPortfolios = await txDatabase
      .selectDistinct({ portfolioId: transaction.portfolioId })
      .from(transaction)
      .where(eq(transaction.instrumentId, targetInstrument.id));

    for (const { portfolioId } of affectedPortfolios) {
      await assertInstrumentLedgerValid({
        database: txDatabase,
        portfolioId,
        instrumentId: targetInstrument.id,
        symbol: targetInstrument.symbol,
        dividendMode: appSettings.dividendMode,
      });
    }

    return {
      id: created.id,
      instrumentId: targetInstrument.id,
      symbol: targetInstrument.symbol,
      instrumentName: targetInstrument.name,
      exDate: created.exDate,
      ratioNumerator: created.ratioNumerator,
      ratioDenominator: created.ratioDenominator,
    };
  });
}

export async function deleteCorporateSplit(
  id: string,
  db?: Database,
): Promise<void> {
  const database = db ?? (await getDb());
  const appSettings = await getOrCreateSettings(database);

  await database.transaction(async (txDb) => {
    const txDatabase = txDb as unknown as Database;

    const existingRows = await txDatabase
      .select()
      .from(corporateAction)
      .where(eq(corporateAction.id, id))
      .limit(1);

    const existing = existingRows[0];
    if (!existing) {
      throw new LedgerUserError("Corporate action not found.", 404);
    }

    const instrRows = await txDatabase
      .select()
      .from(instrument)
      .where(eq(instrument.id, existing.instrumentId))
      .limit(1);

    await txDatabase
      .delete(corporateAction)
      .where(eq(corporateAction.id, id));

    if (instrRows[0]) {
      const affectedPortfolios = await txDatabase
        .selectDistinct({ portfolioId: transaction.portfolioId })
        .from(transaction)
        .where(eq(transaction.instrumentId, existing.instrumentId));

      for (const { portfolioId } of affectedPortfolios) {
        await assertInstrumentLedgerValid({
          database: txDatabase,
          portfolioId,
          instrumentId: existing.instrumentId,
          symbol: instrRows[0].symbol,
          dividendMode: appSettings.dividendMode,
        });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Ledger Summary Snapshot (used by Transactions & Holdings views)
// ---------------------------------------------------------------------------

export interface LedgerPositionSummary {
  portfolioId: string;
  portfolioName: string;
  instrumentId: string;
  symbol: string;
  instrumentName: string | null;
  currency: string;
  sharesHeld: string;
  averageCostPerShare: string | null;
  openCostBasis: string;
  realizedPnl: string;
  dividendsReceived: string;
  closedTradeCount: number;
  zeroCostBuyCount: number;
}

export async function computeLedgerSummaries(
  portfolioFilterId?: string,
  db?: Database,
): Promise<{
  positions: LedgerPositionSummary[];
  zeroCostBuys: {
    transactionId: string;
    portfolioName: string;
    symbol: string;
    localDate: string;
    shares: string;
  }[];
}> {
  const database = db ?? (await getDb());
  const appSettings = await getOrCreateSettings(database);

  // Load every portfolio's rows (even when filtering) because a `Sell All` in
  // one portfolio also closes the same symbol in the others.
  const txRows = await database
    .select({
      tx: transaction,
      portfolioName: portfolio.name,
      symbol: instrument.symbol,
      instrumentName: instrument.name,
    })
    .from(transaction)
    .innerJoin(portfolio, eq(transaction.portfolioId, portfolio.id))
    .innerJoin(instrument, eq(transaction.instrumentId, instrument.id));

  const allSplits = await database.select().from(corporateAction);
  const splitsByInstrument = new Map<string, SplitAction[]>();
  for (const row of allSplits) {
    const list = splitsByInstrument.get(row.instrumentId) ?? [];
    list.push({
      id: row.id,
      exDate: row.exDate,
      ratioNumerator: row.ratioNumerator,
      ratioDenominator: row.ratioDenominator,
    });
    splitsByInstrument.set(row.instrumentId, list);
  }

  // Load any stored FX rates so historical base-currency math is ready.
  const fxRows = await database.select().from(fxRate);
  const fxBook = new FxRateBook(fxRows);

  // Group transactions by (portfolioId, instrumentId) — portfolios stay independent.
  const grouped = new Map<
    string,
    {
      portfolioId: string;
      portfolioName: string;
      instrumentId: string;
      symbol: string;
      instrumentName: string | null;
      currency: string;
      txs: Transaction[];
    }
  >();

  for (const row of txRows) {
    const key = `${row.tx.portfolioId}::${row.tx.instrumentId}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.txs.push(row.tx);
    } else {
      grouped.set(key, {
        portfolioId: row.tx.portfolioId,
        portfolioName: row.portfolioName,
        instrumentId: row.tx.instrumentId,
        symbol: row.symbol,
        instrumentName: row.instrumentName,
        currency: row.tx.currency,
        txs: [row.tx],
      });
    }
  }

  const positions: LedgerPositionSummary[] = [];
  const zeroCostBuys: {
    transactionId: string;
    portfolioName: string;
    symbol: string;
    localDate: string;
    shares: string;
  }[] = [];

  // Evaluate each instrument across all of its portfolios so `Sell All` is
  // symbol-wide, then report only the requested portfolio(s).
  const groupsByInstrument = new Map<
    string,
    NonNullable<ReturnType<typeof grouped.get>>[]
  >();
  for (const group of grouped.values()) {
    const list = groupsByInstrument.get(group.instrumentId) ?? [];
    list.push(group);
    groupsByInstrument.set(group.instrumentId, list);
  }

  for (const instrumentGroups of groupsByInstrument.values()) {
    const instrumentId = instrumentGroups[0].instrumentId;
    const symbol = instrumentGroups[0].symbol;
    const splits = splitsByInstrument.get(instrumentId) ?? [];

    const expanded = applySymbolWideSellAll(
      instrumentGroups.map((group) => ({
        portfolioId: group.portfolioId,
        transactions: group.txs.map(mapDbTransactionToFifoInput),
      })),
      { symbol, dividendMode: appSettings.dividendMode, splits },
    );

    for (const group of instrumentGroups) {
      if (portfolioFilterId && group.portfolioId !== portfolioFilterId) {
        continue;
      }

      const ledger = expanded.find((l) => l.portfolioId === group.portfolioId);
      const fifo = evaluateFifoLedger(ledger?.transactions ?? [], {
        symbol: group.symbol,
        dividendMode: appSettings.dividendMode,
        splits,
        baseCurrency: appSettings.baseCurrency,
        fxRateBook: fxBook,
        onValidationError: "clamp-and-flag",
      });

      const avgCost = fifo.sharesHeld.gt(ZERO)
        ? fifo.openCostBasis.div(fifo.sharesHeld)
        : null;

      positions.push({
        portfolioId: group.portfolioId,
        portfolioName: group.portfolioName,
        instrumentId: group.instrumentId,
        symbol: group.symbol,
        instrumentName: group.instrumentName,
        currency: group.currency,
        sharesHeld: toDecimalString(fifo.sharesHeld, 8),
        averageCostPerShare: toNullableDecimalString(avgCost, 6),
        openCostBasis: toDecimalString(fifo.openCostBasis, 4),
        realizedPnl: toDecimalString(fifo.realizedPnl, 4),
        dividendsReceived: toDecimalString(fifo.dividendsReceived, 4),
        closedTradeCount: fifo.closedTradeCount,
        zeroCostBuyCount: fifo.zeroCostBuys.length,
      });

      for (const flag of fifo.zeroCostBuys) {
        zeroCostBuys.push({
          transactionId: flag.transactionId,
          portfolioName: group.portfolioName,
          symbol: group.symbol,
          localDate: flag.localDate,
          shares: toDecimalString(flag.shares, 8),
        });
      }
    }
  }

  return { positions, zeroCostBuys };
}
