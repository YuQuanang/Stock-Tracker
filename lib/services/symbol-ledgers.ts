/**
 * Per-instrument ledger evaluation across ALL portfolios (server-side).
 *
 * Loads every transaction of one instrument, applies the symbol-wide `Sell All`
 * rule (see `lib/finance/symbol-wide-sell-all.ts`), and evaluates each
 * portfolio's FIFO ledger. Used by validation and SGD-total reconciliation so
 * they agree exactly with the holdings and summary screens.
 */
import { asc, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { corporateAction, transaction, type Transaction } from "@/db/schema";
import {
  applySymbolWideSellAll,
  type DividendInterpretation,
  evaluateFifoLedger,
  type FifoEvaluationResult,
  type LedgerTransactionInput,
} from "@/lib/finance";

export function mapTransactionRowToLedgerInput(
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

export interface InstrumentPortfolioEvaluation {
  portfolioId: string;
  rows: Transaction[];
  fifo: FifoEvaluationResult;
}

export async function evaluateInstrumentAcrossPortfolios(params: {
  database: Database;
  instrumentId: string;
  symbol: string;
  dividendMode: DividendInterpretation;
  onValidationError: "throw" | "clamp-and-flag";
}): Promise<InstrumentPortfolioEvaluation[]> {
  const [rows, splitRows] = await Promise.all([
    params.database
      .select()
      .from(transaction)
      .where(eq(transaction.instrumentId, params.instrumentId)),
    params.database
      .select()
      .from(corporateAction)
      .where(eq(corporateAction.instrumentId, params.instrumentId))
      .orderBy(asc(corporateAction.exDate)),
  ]);

  const splits = splitRows.map((row) => ({
    id: row.id,
    exDate: row.exDate,
    ratioNumerator: row.ratioNumerator,
    ratioDenominator: row.ratioDenominator,
  }));

  const rowsByPortfolio = new Map<string, Transaction[]>();
  for (const row of rows) {
    const list = rowsByPortfolio.get(row.portfolioId) ?? [];
    list.push(row);
    rowsByPortfolio.set(row.portfolioId, list);
  }

  const expanded = applySymbolWideSellAll(
    [...rowsByPortfolio.entries()].map(([portfolioId, list]) => ({
      portfolioId,
      transactions: list.map(mapTransactionRowToLedgerInput),
    })),
    { symbol: params.symbol, dividendMode: params.dividendMode, splits },
  );

  return expanded.map((ledger) => ({
    portfolioId: ledger.portfolioId,
    rows: rowsByPortfolio.get(ledger.portfolioId) ?? [],
    fifo: evaluateFifoLedger(ledger.transactions, {
      symbol: params.symbol,
      dividendMode: params.dividendMode,
      splits,
      onValidationError: params.onValidationError,
    }),
  }));
}

