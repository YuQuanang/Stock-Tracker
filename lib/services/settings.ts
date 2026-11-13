/**
 * Server-Side Settings & Privacy / Data-Reset Service (`lib/services/settings.ts`).
 *
 * Manages Folio's single-row `settings` record (`baseCurrency`, `riskFreeRate`,
 * `defaultBenchmark`, `dividendMode`, `theme`, `gainColorScheme`,
 * `numberFormat`, `dateFormat`, `timezone`), propagates `dividendMode` changes
 * cleanly to historical SGD dividend snapshots, and supports atomic deletion of
 * all portfolio data ("Danger Zone").
 */
import { eq } from "drizzle-orm";
import { type Database, getDb } from "@/db/client";
import {
  corporateAction,
  csvImportLog,
  fxRate,
  instrument,
  portfolio,
  portfolioInstrument,
  priceBar,
  settings,
  type Settings,
  transaction,
} from "@/db/schema";
import { toDecimal, toDecimalString, ZERO } from "@/lib/finance";
import {
  type LedgerPairIdentifier,
  reconcileLedgerPairsSgdTotals,
} from "@/lib/services/fx-sgd";
import { FxRateBook } from "@/lib/finance/fx";
import { getOrCreateSettings, LedgerUserError } from "@/lib/services/ledger";

export interface UpdateSettingsPatch {
  baseCurrency?: "SGD" | "USD";
  riskFreeRate?: string;
  defaultBenchmark?: string;
  costBasisMethod?: "FIFO";
  dividendMode?: "cash" | "shares";
  theme?: "system" | "light" | "dark";
  gainColorScheme?: "green-up" | "red-up" | "color-blind-safe";
  numberFormat?: "en-SG" | "en-US";
  dateFormat?: "dd MMM yyyy" | "yyyy-MM-dd" | "MM/dd/yyyy";
  timezone?: string;
}

/** Updates Folio settings cleanly, normalizing decimal risk-free rate and benchmark symbol. */
export async function updateSettings(
  patch: UpdateSettingsPatch,
  db?: Database,
): Promise<Settings> {
  const database = db ?? (await getDb());
  const current = await getOrCreateSettings(database);

  const updates: Partial<typeof settings.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (patch.baseCurrency !== undefined) {
    updates.baseCurrency = patch.baseCurrency;
  }

  if (patch.riskFreeRate !== undefined) {
    const rf = toDecimal(patch.riskFreeRate);
    if (rf.lt(ZERO) || rf.gt(toDecimal("0.25"))) {
      throw new LedgerUserError(
        "Risk-free rate must be between 0% and 25%.",
        422,
      );
    }
    updates.riskFreeRate = toDecimalString(rf.toDecimalPlaces(6), 6);
  }

  if (patch.defaultBenchmark !== undefined) {
    const cleaned = patch.defaultBenchmark.trim().toUpperCase();
    if (!cleaned) {
      throw new LedgerUserError("Default benchmark symbol is required.", 422);
    }
    updates.defaultBenchmark = cleaned;
  }

  if (patch.costBasisMethod !== undefined) {
    updates.costBasisMethod = patch.costBasisMethod;
  }

  if (patch.dividendMode !== undefined) {
    updates.dividendMode = patch.dividendMode;
  }

  if (patch.theme !== undefined) {
    updates.theme = patch.theme;
  }

  if (patch.gainColorScheme !== undefined) {
    updates.gainColorScheme = patch.gainColorScheme;
  }

  if (patch.numberFormat !== undefined) {
    updates.numberFormat = patch.numberFormat;
  }

  if (patch.dateFormat !== undefined) {
    updates.dateFormat = patch.dateFormat;
  }

  if (patch.timezone !== undefined) {
    const cleanedTz = patch.timezone.trim();
    if (!cleanedTz) {
      throw new LedgerUserError("Timezone cannot be empty.", 422);
    }
    updates.timezone = cleanedTz;
  }

  const [updated] = await database
    .update(settings)
    .set(updates)
    .where(eq(settings.id, 1))
    .returning();

  const resolved = updated ?? (await getOrCreateSettings(database));

  // If dividend interpretation toggled between cash and shares, reconcile
  // `total_cost_sgd` on pairs containing dividends so SGD totals stay consistent.
  if (
    patch.dividendMode !== undefined &&
    patch.dividendMode !== current.dividendMode
  ) {
    const divRows = await database
      .select({
        portfolioId: transaction.portfolioId,
        instrumentId: transaction.instrumentId,
        symbol: instrument.symbol,
      })
      .from(transaction)
      .innerJoin(instrument, eq(transaction.instrumentId, instrument.id))
      .where(eq(transaction.type, "Dividend"));

    if (divRows.length > 0) {
      const pairMap = new Map<string, LedgerPairIdentifier>();
      for (const row of divRows) {
        pairMap.set(`${row.portfolioId}::${row.instrumentId}`, row);
      }
      const fxRows = await database.select().from(fxRate);
      const sourceByDate = new Map<string, string>();
      for (const row of fxRows) {
        if (row.fromCurrency === "USD" && row.toCurrency === "SGD") {
          sourceByDate.set(row.date, row.source);
        }
      }
      await reconcileLedgerPairsSgdTotals({
        pairs: [...pairMap.values()],
        database,
        dividendMode: resolved.dividendMode,
        fxBook: new FxRateBook(fxRows),
        sourceByDate,
      });
    }
  }

  return resolved;
}

/**
 * Deletes every user portfolio, transaction, instrument, corporate action,
 * import log, and cached price/FX history cleanly inside a single DB
 * transaction, resetting preferences to clean defaults.
 */
export async function deleteAllPortfolioData(db?: Database): Promise<void> {
  const database = db ?? (await getDb());

  await database.transaction(async (tx) => {
    await tx.delete(transaction);
    await tx.delete(corporateAction);
    await tx.delete(portfolioInstrument);
    await tx.delete(portfolio);
    await tx.delete(priceBar);
    await tx.delete(instrument);
    await tx.delete(csvImportLog);
    await tx.delete(fxRate);
    await tx.delete(settings);
    await tx.insert(settings).values({ id: 1 }).onConflictDoNothing();
  });
}

