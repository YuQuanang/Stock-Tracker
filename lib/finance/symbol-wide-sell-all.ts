/**
 * Symbol-wide "Sell All" (`lib/finance/symbol-wide-sell-all.ts`).
 *
 * Folio keeps one independent FIFO ledger per `(portfolio, symbol)` pair, but a
 * `Sell All` means "I no longer own this stock" - in EVERY portfolio. Without
 * this rule a `Sell All` recorded in portfolio A leaves shares of the same
 * symbol in portfolio B open forever, so holdings keep showing unrealized P&L
 * on a stock that has been fully sold.
 *
 * How it works, in words:
 *   1. Collect every real `Sell All` for the symbol across all portfolios and
 *      walk them in chronological order.
 *   2. For each one, look at every OTHER portfolio. If that portfolio still held
 *      shares at that exact moment (evaluated with the normal FIFO engine), add a
 *      "mirrored" `Sell All` to its ledger at the same time and price.
 *   3. Each ledger is then evaluated by the normal FIFO engine, so lots are
 *      closed oldest-first, realized P&L uses the same sale price, and shares
 *      bought AFTER the Sell All stay open as expected.
 *
 * Nothing is written to the database: mirrored rows exist only in memory, so the
 * lossless MSP CSV export is unaffected. Every code path that evaluates a ledger
 * (holdings, summaries, validation, SGD totals) must go through this function so
 * they can never disagree.
 */
import { QUANTITY_EPSILON } from "@/lib/finance/decimal";
import {
  evaluateFifoLedger,
  type DividendInterpretation,
  type LedgerTransactionInput,
  sortTransactionsChronologically,
} from "@/lib/finance/fifo";
import type { SplitAction } from "@/lib/finance/splits";

const MIRROR_MARKER = "::sell-all-mirror::";

export interface PortfolioLedgerInput {
  portfolioId: string;
  transactions: readonly LedgerTransactionInput[];
}

/** Builds the in-memory id of a `Sell All` mirrored into another portfolio. */
export function buildMirroredSellAllId(
  sourceTransactionId: string,
  targetPortfolioId: string,
): string {
  return `${sourceTransactionId}${MIRROR_MARKER}${targetPortfolioId}`;
}

export function isMirroredSellAllId(transactionId: string): boolean {
  return transactionId.includes(MIRROR_MARKER);
}

/** Maps a mirrored id back to the real stored `Sell All` transaction id. */
export function resolveSellAllSourceId(transactionId: string): string {
  const markerIndex = transactionId.indexOf(MIRROR_MARKER);
  return markerIndex === -1 ? transactionId : transactionId.slice(0, markerIndex);
}

export interface ApplySymbolWideSellAllOptions {
  symbol?: string;
  dividendMode?: DividendInterpretation;
  splits?: readonly SplitAction[];
}

/**
 * Returns new per-portfolio ledgers where every real `Sell All` also closes the
 * same symbol in the other portfolios that held shares at that moment.
 * Input arrays are never mutated.
 */
export function applySymbolWideSellAll(
  portfolios: readonly PortfolioLedgerInput[],
  options: ApplySymbolWideSellAllOptions = {},
): PortfolioLedgerInput[] {
  const ledgers = new Map<string, LedgerTransactionInput[]>();
  const ownerByTransactionId = new Map<string, string>();

  for (const portfolio of portfolios) {
    ledgers.set(portfolio.portfolioId, [...portfolio.transactions]);
    for (const tx of portfolio.transactions) {
      if (tx.type === "Sell All") {
        ownerByTransactionId.set(tx.id, portfolio.portfolioId);
      }
    }
  }

  const realSellAlls = sortTransactionsChronologically(
    portfolios.flatMap((portfolio) =>
      portfolio.transactions.filter((tx) => tx.type === "Sell All"),
    ),
  );

  for (const sellAll of realSellAlls) {
    const ownerPortfolioId = ownerByTransactionId.get(sellAll.id);
    let closedInOtherPortfolio = false;

    for (const [portfolioId, ledger] of ledgers) {
      if (portfolioId === ownerPortfolioId) {
        continue;
      }

      // Everything this portfolio did strictly before the Sell All (using the
      // engine's own tie-break order for identical timestamps).
      const ordered = sortTransactionsChronologically([...ledger, sellAll]);
      const history = ordered.slice(0, ordered.indexOf(sellAll));

      const before = evaluateFifoLedger(history, {
        symbol: options.symbol,
        dividendMode: options.dividendMode,
        splits: options.splits,
        onValidationError: "clamp-and-flag",
      });

      if (before.sharesHeld.lte(QUANTITY_EPSILON)) {
        continue;
      }

      closedInOtherPortfolio = true;
      ledger.push({
        ...sellAll,
        id: buildMirroredSellAllId(sellAll.id, portfolioId),
        quantity: 0,
        commissionRaw: "0",
        commissionValue: 0,
        commissionIsPercent: false,
      });
    }

    // If the portfolio where `Sell All` was recorded held 0 shares itself at
    // that moment, but another portfolio held shares that this `Sell All` just
    // closed, omit the row from the empty owner portfolio's in-memory FIFO evaluation
    // so it does not raise a false `SELL_ALL_WHEN_EMPTY` error.
    if (closedInOtherPortfolio && ownerPortfolioId) {
      const ownerLedger = ledgers.get(ownerPortfolioId);
      if (ownerLedger) {
        const orderedOwner = sortTransactionsChronologically(ownerLedger);
        const idx = orderedOwner.findIndex((tx) => tx.id === sellAll.id);
        const ownerHistory = idx >= 0 ? orderedOwner.slice(0, idx) : orderedOwner;
        const ownerBefore = evaluateFifoLedger(ownerHistory, {
          symbol: options.symbol,
          dividendMode: options.dividendMode,
          splits: options.splits,
          onValidationError: "clamp-and-flag",
        });

        if (ownerBefore.sharesHeld.lte(QUANTITY_EPSILON)) {
          ledgers.set(
            ownerPortfolioId,
            ownerLedger.filter((tx) => tx.id !== sellAll.id),
          );
        }
      }
    }
  }

  return portfolios.map((portfolio) => ({
    portfolioId: portfolio.portfolioId,
    transactions: ledgers.get(portfolio.portfolioId) ?? [],
  }));
}

