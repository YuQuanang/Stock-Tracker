/**
 * Chronological First-In, First-Out (FIFO) ledger engine.
 *
 * The transaction ledger is Folio's single source of truth. Given an unordered
 * list of transactions (and optional stock splits) for one `(portfolio, symbol)`
 * pair, this module deterministically computes:
 *   - remaining open FIFO lots and their exact cost basis,
 *   - closed lot matches and realized P&L per closed lot and per sell,
 *   - dividends received (supporting both cash and reinvested-shares modes),
 *   - historical base-currency cost basis per lot, and
 *   - data-quality / validation issues (oversells, empty Sell All, zero-cost
 *     buys, missing historical FX rates).
 */
import {
  computeCommissionAmount,
  parseCommissionInput,
} from "@/lib/finance/commission";
import { formatInstantInOffset } from "@/lib/finance/date";
import {
  type DecimalInput,
  type DecimalValue,
  FinanceDecimal,
  HUNDRED,
  QUANTITY_EPSILON,
  safeDivide,
  toDecimal,
  ZERO,
} from "@/lib/finance/decimal";
import { FxRateBook, lookupFxRate } from "@/lib/finance/fx";
import { applySplitToOpenLot, type SplitAction } from "@/lib/finance/splits";

export type LedgerTransactionType = "Buy" | "Sell" | "Sell All" | "Dividend";
export type DividendInterpretation = "cash" | "shares";

export interface LedgerTransactionInput {
  id: string;
  type: LedgerTransactionType;
  quantity: DecimalInput;
  price: DecimalInput;
  /** Either raw text (`"1%"`, `"1.14"`) or pre-parsed fields below. */
  commissionRaw?: string | null;
  commissionValue?: DecimalInput | null;
  commissionIsPercent?: boolean;
  executedAt: Date;
  /** Original UTC offset string such as `"+0800"`. Defaults to `"+0800"`. */
  originalOffset?: string;
  currency: string;
  purchaseFxRate?: DecimalInput | null;
  purchaseFxCurrencies?: string | null;
  /** Optional SGD trade-entry or historical FX snapshot (`native -> SGD`). */
  fxRateToSgd?: DecimalInput | null;
  /** Original CSV row Id used as tie-breaker on identical timestamps. */
  sourceRowId?: number | null;
  createdAt?: Date;
}

export interface OpenFifoLot {
  buyTransactionId: string;
  openedAt: Date;
  localDate: string;
  /** Original shares opened (adjusted for any subsequent stock splits). */
  initialShares: DecimalValue;
  /** Shares still held in this lot. */
  remainingShares: DecimalValue;
  /** Remaining cost basis in the instrument's native currency (includes buy commission). */
  remainingCostBasis: DecimalValue;
  /** Effective cost per remaining share in native currency (`remainingCostBasis / remainingShares`). */
  costPerShare: DecimalValue;
  /** Historical FX rate (`native -> base`) locked in on the buy date, if requested and available. */
  fxRateToBase: DecimalValue | null;
  /** Remaining cost basis in base currency (`remainingCostBasis * fxRateToBase`). */
  remainingCostBasisInBase: DecimalValue | null;
  /** True when the buy trade price was 0 (gift/transfer). */
  isZeroCostBuy: boolean;
}

export interface ClosedLotMatch {
  buyTransactionId: string;
  sellTransactionId: string;
  openedAt: Date;
  closedAt: Date;
  sharesMatched: DecimalValue;
  /** Cost basis allocated from the buy lot (native currency). */
  costBasis: DecimalValue;
  /** Gross sale proceeds allocated to this lot (`sharesMatched * salePrice`). */
  grossProceeds: DecimalValue;
  /** Portion of sell commission allocated to this lot. */
  commissionAllocated: DecimalValue;
  /** Net sale proceeds (`grossProceeds - commissionAllocated`). */
  netProceeds: DecimalValue;
  /** Realized P&L (`netProceeds - costBasis`) in native currency. */
  realizedPnl: DecimalValue;
  /** Cost basis in base currency at historical buy FX, if available. */
  costBasisInBase: DecimalValue | null;
  /** Net proceeds in base currency at historical sell FX, if available. */
  netProceedsInBase: DecimalValue | null;
  /** Realized P&L in base currency (`netProceedsInBase - costBasisInBase`), if available. */
  realizedPnlInBase: DecimalValue | null;
}

export interface DividendRecord {
  transactionId: string;
  executedAt: Date;
  localDate: string;
  sharesEligible: DecimalValue;
  dividendPerShare: DecimalValue;
  grossAmount: DecimalValue;
  grossAmountInBase: DecimalValue | null;
  commission: DecimalValue;
  commissionInBase: DecimalValue | null;
  taxPercent: DecimalValue;
  netAmount: DecimalValue;
  netAmountInBase: DecimalValue | null;
  fxRateToBase: DecimalValue | null;
  reinvestedShares: DecimalValue;
}

export interface ZeroCostBuyFlag {
  transactionId: string;
  executedAt: Date;
  localDate: string;
  shares: DecimalValue;
}

export interface MissingFxFlag {
  transactionId: string;
  localDate: string;
  fromCurrency: string;
  toCurrency: string;
}

export type LedgerValidationCode =
  | "OVERSELL"
  | "SELL_ALL_WHEN_EMPTY"
  | "INVALID_QUANTITY"
  | "INVALID_PRICE";

export interface LedgerValidationIssue {
  code: LedgerValidationCode;
  transactionId: string;
  executedAt: Date;
  localDate: string;
  message: string;
  requestedShares?: DecimalValue;
  availableShares?: DecimalValue;
}

export class FifoValidationError extends Error {
  public readonly issue: LedgerValidationIssue;

  constructor(issue: LedgerValidationIssue) {
    super(issue.message);
    this.name = "FifoValidationError";
    this.issue = issue;
  }
}

export interface EvaluateFifoOptions {
  /** Symbol label used in human-readable validation messages. */
  symbol?: string;
  /** `"cash"` (default, section 7.4) or `"shares"` (DRIP reinvestment). */
  dividendMode?: DividendInterpretation;
  /** Stock splits for this instrument; applied chronologically on `exDate`. */
  splits?: readonly SplitAction[];
  /**
   * Optional cut-off date (`YYYY-MM-DD`). Transactions and splits after this
   * local date are ignored — used when reconstructing historical daily values.
   */
  asOfDate?: string;
  /** Optional base currency (`"SGD"` or `"USD"`) for historical FX cost basis. */
  baseCurrency?: string;
  /** Historical FX rate book used when `baseCurrency` is provided. */
  fxRateBook?: FxRateBook;
  /**
   * `"throw"` (default) throws `FifoValidationError` on oversells or invalid
   * quantities; `"clamp-and-flag"` records the issue and continues so read-only
   * views and Data Quality screens never crash on bad historical rows.
   */
  onValidationError?: "throw" | "clamp-and-flag";
}

export interface FifoEvaluationResult {
  openLots: OpenFifoLot[];
  closedLotMatches: ClosedLotMatch[];
  dividends: DividendRecord[];
  /** Current open shares (`sum of remainingShares` across open lots). */
  sharesHeld: DecimalValue;
  /** Remaining cost basis of open shares in native currency. */
  openCostBasis: DecimalValue;
  /**
   * Remaining cost basis of open shares in base currency, or `null` when
   * `baseCurrency` was not requested or any open lot lacked an FX rate.
   */
  openCostBasisInBase: DecimalValue | null;
  /** Cumulative gross capital put into buys (native currency). */
  totalCapitalInvested: DecimalValue;
  /** Cumulative realized P&L across all closed lot matches (native currency). */
  realizedPnl: DecimalValue;
  /** Cumulative realized P&L in base currency, or `null` if any closed lot lacked FX. */
  realizedPnlInBase: DecimalValue | null;
  /** Cumulative net cash (or reinvested) dividends in native currency. */
  dividendsReceived: DecimalValue;
  /** Cumulative net dividends in base currency, or `null` if any dividend lacked FX. */
  dividendsReceivedInBase: DecimalValue | null;
  /** Total trades that closed at least one lot (for closed-trade win-rate metrics). */
  closedTradeCount: number;
  /** Closed sell trades whose net realized P&L was strictly greater than zero. */
  winningTradeCount: number;
  /** Data-quality flags and non-fatal issues. */
  zeroCostBuys: ZeroCostBuyFlag[];
  missingFxFlags: MissingFxFlag[];
  validationIssues: LedgerValidationIssue[];
}

/**
 * Sorts transactions chronologically:
 *   1. `executedAt` UTC timestamp ascending,
 *   2. `sourceRowId` ascending (imported CSV order for same-minute trades),
 *   3. `createdAt` ascending,
 *   4. `id` ascending.
 */
export function sortTransactionsChronologically<
  T extends Pick<
    LedgerTransactionInput,
    "id" | "executedAt" | "sourceRowId" | "createdAt"
  >,
>(transactions: readonly T[]): T[] {
  return [...transactions].sort((left, right) => {
    const timeDiff = left.executedAt.getTime() - right.executedAt.getTime();
    if (timeDiff !== 0) {
      return timeDiff;
    }

    const leftRowId = left.sourceRowId ?? Number.MAX_SAFE_INTEGER;
    const rightRowId = right.sourceRowId ?? Number.MAX_SAFE_INTEGER;
    if (leftRowId !== rightRowId) {
      return leftRowId - rightRowId;
    }

    const leftCreated = left.createdAt?.getTime() ?? 0;
    const rightCreated = right.createdAt?.getTime() ?? 0;
    if (leftCreated !== rightCreated) {
      return leftCreated - rightCreated;
    }

    return left.id.localeCompare(right.id);
  });
}

/** Resolves parsed commission fields whether the caller passed raw text or DB columns. */
function resolveCommission(tx: LedgerTransactionInput): {
  value: DecimalValue;
  isPercent: boolean;
} {
  if (tx.commissionValue !== undefined && tx.commissionValue !== null) {
    return {
      value: toDecimal(tx.commissionValue),
      isPercent: Boolean(tx.commissionIsPercent),
    };
  }
  const parsed = parseCommissionInput(tx.commissionRaw);
  return {
    value: parsed.value,
    isPercent: parsed.isPercent,
  };
}

/** Sums `remainingShares` across all currently open FIFO lots. */
function sumOpenShares(openLots: readonly OpenFifoLot[]): DecimalValue {
  let total = ZERO;
  for (const lot of openLots) {
    total = total.plus(lot.remainingShares);
  }
  return total;
}

/**
 * Evaluates a chronological ledger using First-In, First-Out (FIFO) accounting.
 *
 * Key formulas in words:
 *   - Buy lot cost basis      = (sharesBought * buyPrice) + buyCommission
 *   - Partial lot cost basis  = lotRemainingCostBasis * (sharesMatched / lotRemainingShares)
 *   - Net sale proceeds       = (sharesSold * salePrice) - sellCommission
 *   - Realized P&L on a lot   = allocatedNetSaleProceeds - allocatedLotCostBasis
 *   - Sell All quantity       = sum of remainingShares across all open lots at that instant
 */
export function evaluateFifoLedger(
  transactions: readonly LedgerTransactionInput[],
  options: EvaluateFifoOptions = {},
): FifoEvaluationResult {
  const symbolLabel = options.symbol ?? "instrument";
  const dividendMode = options.dividendMode ?? "cash";
  const errorMode = options.onValidationError ?? "throw";
  const asOfDate = options.asOfDate;

  const sortedTransactions = sortTransactionsChronologically(transactions);
  const sortedSplits = [...(options.splits ?? [])].sort((a, b) =>
    a.exDate.localeCompare(b.exDate),
  );
  let nextSplitIndex = 0;

  const openLots: OpenFifoLot[] = [];
  const closedLotMatches: ClosedLotMatch[] = [];
  const dividends: DividendRecord[] = [];
  const zeroCostBuys: ZeroCostBuyFlag[] = [];
  const missingFxFlags: MissingFxFlag[] = [];
  const validationIssues: LedgerValidationIssue[] = [];

  let totalCapitalInvested = ZERO;
  let closedTradeCount = 0;
  let winningTradeCount = 0;

  function recordIssue(issue: LedgerValidationIssue): void {
    validationIssues.push(issue);
    if (errorMode === "throw") {
      throw new FifoValidationError(issue);
    }
  }

  function resolveHistoricalFx(
    tx: LedgerTransactionInput,
    localDate: string,
  ): DecimalValue | null {
    if (!options.baseCurrency) {
      return null;
    }
    const base = options.baseCurrency.trim().toUpperCase();
    const native = tx.currency.trim().toUpperCase();
    if (native === base) {
      return new FinanceDecimal(1);
    }
    const hasPurchaseFx =
      tx.purchaseFxRate !== null &&
      tx.purchaseFxRate !== undefined &&
      String(tx.purchaseFxRate).trim() !== "";
    const hasSgdSnapshotFx =
      base === "SGD" &&
      tx.fxRateToSgd !== null &&
      tx.fxRateToSgd !== undefined &&
      String(tx.fxRateToSgd).trim() !== "";

    if (!hasPurchaseFx && !hasSgdSnapshotFx && !options.fxRateBook) {
      missingFxFlags.push({
        transactionId: tx.id,
        localDate,
        fromCurrency: native,
        toCurrency: base,
      });
      return null;
    }

    const lookup = lookupFxRate({
      fromCurrency: native,
      toCurrency: base,
      date: localDate,
      explicitRate: hasPurchaseFx
        ? tx.purchaseFxRate
        : hasSgdSnapshotFx
          ? tx.fxRateToSgd
          : null,
      explicitCurrencies: hasPurchaseFx ? tx.purchaseFxCurrencies : `${native}/SGD`,
      rateBook: options.fxRateBook ?? new FxRateBook(),
    });
    if (lookup.rate === null) {
      missingFxFlags.push({
        transactionId: tx.id,
        localDate,
        fromCurrency: native,
        toCurrency: base,
      });
    }
    return lookup.rate;
  }

  function applySplitsUpTo(dateInclusive: string): void {
    while (
      nextSplitIndex < sortedSplits.length &&
      sortedSplits[nextSplitIndex].exDate <= dateInclusive
    ) {
      const split = sortedSplits[nextSplitIndex];
      for (const lot of openLots) {
        applySplitToOpenLot(lot, split);
      }
      nextSplitIndex += 1;
    }
  }

  function openNewLot(params: {
    tx: LedgerTransactionInput;
    localDate: string;
    shares: DecimalValue;
    lotCostBasis: DecimalValue;
    isZeroCostBuy: boolean;
  }): void {
    const fxRateToBase = resolveHistoricalFx(params.tx, params.localDate);
    const remainingCostBasisInBase =
      fxRateToBase !== null ? params.lotCostBasis.mul(fxRateToBase) : null;
    const costPerShare =
      safeDivide(params.lotCostBasis, params.shares) ?? ZERO;

    openLots.push({
      buyTransactionId: params.tx.id,
      openedAt: params.tx.executedAt,
      localDate: params.localDate,
      initialShares: params.shares,
      remainingShares: params.shares,
      remainingCostBasis: params.lotCostBasis,
      costPerShare,
      fxRateToBase,
      remainingCostBasisInBase,
      isZeroCostBuy: params.isZeroCostBuy,
    });
  }

  for (const tx of sortedTransactions) {
    const { localDate } = formatInstantInOffset(
      tx.executedAt,
      tx.originalOffset ?? "+0800",
    );

    if (asOfDate !== undefined && localDate > asOfDate) {
      break;
    }

    // Apply any stock splits whose ex-date has arrived on or before this trade.
    applySplitsUpTo(localDate);

    const quantity = toDecimal(tx.quantity);
    const price = toDecimal(tx.price);
    const commissionSpec = resolveCommission(tx);

    if (price.isNegative()) {
      recordIssue({
        code: "INVALID_PRICE",
        transactionId: tx.id,
        executedAt: tx.executedAt,
        localDate,
        message: `${symbolLabel} on ${localDate}: price cannot be negative (${price.toFixed()}).`,
      });
      continue;
    }

    if (tx.type === "Buy") {
      if (!quantity.gt(ZERO)) {
        recordIssue({
          code: "INVALID_QUANTITY",
          transactionId: tx.id,
          executedAt: tx.executedAt,
          localDate,
          message: `${symbolLabel} on ${localDate}: Buy quantity must be greater than zero.`,
        });
        continue;
      }

      const grossCost = quantity.mul(price);
      const buyCommission = computeCommissionAmount(grossCost, commissionSpec);
      const lotCostBasis = grossCost.plus(buyCommission);
      const isZeroCostBuy = price.isZero();

      if (isZeroCostBuy) {
        zeroCostBuys.push({
          transactionId: tx.id,
          executedAt: tx.executedAt,
          localDate,
          shares: quantity,
        });
      }

      totalCapitalInvested = totalCapitalInvested.plus(lotCostBasis);
      openNewLot({
        tx,
        localDate,
        shares: quantity,
        lotCostBasis,
        isZeroCostBuy,
      });
      continue;
    }

    if (tx.type === "Dividend") {
      if (!quantity.gt(ZERO)) {
        recordIssue({
          code: "INVALID_QUANTITY",
          transactionId: tx.id,
          executedAt: tx.executedAt,
          localDate,
          message: `${symbolLabel} on ${localDate}: Dividend amount must be greater than zero.`,
        });
        continue;
      }

      const dividendFxRate = resolveHistoricalFx(tx, localDate);
      const sharesEligible = sumOpenShares(openLots);

      if (dividendMode === "cash") {
        // Default (section 7.4): `quantity` is the gross cash dividend in native currency.
        const grossDividend = quantity;
        const dividendPerShare = price.gt(ZERO)
          ? price
          : sharesEligible.gt(ZERO)
            ? (safeDivide(grossDividend, sharesEligible) ?? ZERO)
            : ZERO;
        const divCommission = computeCommissionAmount(
          grossDividend,
          commissionSpec,
        );
        const taxPercent = commissionSpec.isPercent
          ? commissionSpec.value
          : grossDividend.gt(ZERO)
            ? (safeDivide(divCommission.mul(HUNDRED), grossDividend) ?? ZERO)
            : ZERO;
        const netDividend = grossDividend.minus(divCommission);
        const grossDividendInBase =
          dividendFxRate !== null ? grossDividend.mul(dividendFxRate) : null;
        const commissionInBase =
          dividendFxRate !== null ? divCommission.mul(dividendFxRate) : null;
        const netDividendInBase =
          dividendFxRate !== null ? netDividend.mul(dividendFxRate) : null;

        dividends.push({
          transactionId: tx.id,
          executedAt: tx.executedAt,
          localDate,
          sharesEligible,
          dividendPerShare,
          grossAmount: grossDividend,
          grossAmountInBase: grossDividendInBase,
          commission: divCommission,
          commissionInBase,
          taxPercent,
          netAmount: netDividend,
          netAmountInBase: netDividendInBase,
          fxRateToBase: dividendFxRate,
          reinvestedShares: ZERO,
        });
      } else {
        // Reinvested shares mode: `quantity` new shares bought at `price`.
        const grossDividend = quantity.mul(price);
        const dividendPerShare = sharesEligible.gt(ZERO)
          ? (safeDivide(grossDividend, sharesEligible) ?? ZERO)
          : price;
        const divCommission = computeCommissionAmount(
          grossDividend,
          commissionSpec,
        );
        const taxPercent = commissionSpec.isPercent
          ? commissionSpec.value
          : grossDividend.gt(ZERO)
            ? (safeDivide(divCommission.mul(HUNDRED), grossDividend) ?? ZERO)
            : ZERO;
        const netDividend = grossDividend.minus(divCommission);
        const grossDividendInBase =
          dividendFxRate !== null ? grossDividend.mul(dividendFxRate) : null;
        const commissionInBase =
          dividendFxRate !== null ? divCommission.mul(dividendFxRate) : null;
        const netDividendInBase =
          dividendFxRate !== null ? netDividend.mul(dividendFxRate) : null;
        const reinvestedLotCost = grossDividend.plus(divCommission);

        dividends.push({
          transactionId: tx.id,
          executedAt: tx.executedAt,
          localDate,
          sharesEligible,
          dividendPerShare,
          grossAmount: grossDividend,
          grossAmountInBase: grossDividendInBase,
          commission: divCommission,
          commissionInBase,
          taxPercent,
          netAmount: netDividend,
          netAmountInBase: netDividendInBase,
          fxRateToBase: dividendFxRate,
          reinvestedShares: quantity,
        });

        totalCapitalInvested = totalCapitalInvested.plus(reinvestedLotCost);
        openNewLot({
          tx,
          localDate,
          shares: quantity,
          lotCostBasis: reinvestedLotCost,
          isZeroCostBuy: price.isZero(),
        });
      }
      continue;
    }

    // `Sell` or `Sell All`
    const availableShares = sumOpenShares(openLots);
    let requestedShares: DecimalValue;

    if (tx.type === "Sell All") {
      if (availableShares.lte(QUANTITY_EPSILON)) {
        recordIssue({
          code: "SELL_ALL_WHEN_EMPTY",
          transactionId: tx.id,
          executedAt: tx.executedAt,
          localDate,
          availableShares: ZERO,
          requestedShares: ZERO,
          message: `Cannot execute "Sell All" for ${symbolLabel} on ${localDate} because 0 shares were held at that time.`,
        });
        continue;
      }
      requestedShares = availableShares;
    } else {
      if (!quantity.gt(ZERO)) {
        recordIssue({
          code: "INVALID_QUANTITY",
          transactionId: tx.id,
          executedAt: tx.executedAt,
          localDate,
          message: `${symbolLabel} on ${localDate}: Sell quantity must be greater than zero.`,
        });
        continue;
      }
      requestedShares = quantity;
    }

    if (requestedShares.gt(availableShares.plus(QUANTITY_EPSILON))) {
      recordIssue({
        code: "OVERSELL",
        transactionId: tx.id,
        executedAt: tx.executedAt,
        localDate,
        requestedShares,
        availableShares,
        message: `Cannot sell ${requestedShares.toFixed()} shares of ${symbolLabel} on ${localDate}: only ${availableShares.toFixed()} shares were held at that time.`,
      });
      if (availableShares.lte(QUANTITY_EPSILON)) {
        continue;
      }
      requestedShares = availableShares;
    }

    // Clamp tiny split-ratio epsilon when selling virtually the entire holding.
    const actualSharesToSell = requestedShares.gt(availableShares)
      ? availableShares
      : requestedShares;

    const totalGrossProceeds = actualSharesToSell.mul(price);
    const totalSellCommission = computeCommissionAmount(
      totalGrossProceeds,
      commissionSpec,
    );
    const totalNetProceeds = totalGrossProceeds.minus(totalSellCommission);
    const sellFxRate = resolveHistoricalFx(tx, localDate);

    let remainingToMatch = actualSharesToSell;
    let remainingGrossProceeds = totalGrossProceeds;
    let remainingCommission = totalSellCommission;
    let remainingNetProceeds = totalNetProceeds;
    let tradeRealizedPnl = ZERO;

    while (remainingToMatch.gt(QUANTITY_EPSILON) && openLots.length > 0) {
      const oldestLot = openLots[0];
      const lotDifference = oldestLot.remainingShares.minus(remainingToMatch);
      const consumesEntireLot = lotDifference.lte(QUANTITY_EPSILON);

      const sharesMatched = consumesEntireLot
        ? oldestLot.remainingShares
        : remainingToMatch;

      const isFinalMatchForThisSell =
        consumesEntireLot && lotDifference.abs().lte(QUANTITY_EPSILON)
          ? true
          : !consumesEntireLot;

      // Allocate cost basis from the lot proportionally, consuming the exact
      // remainder when the lot is fully closed so zero rounding dust remains.
      let allocatedCostBasis: DecimalValue;
      let allocatedCostBasisInBase: DecimalValue | null;

      if (consumesEntireLot) {
        allocatedCostBasis = oldestLot.remainingCostBasis;
        allocatedCostBasisInBase = oldestLot.remainingCostBasisInBase;
        openLots.shift();
      } else {
        allocatedCostBasis = oldestLot.remainingCostBasis
          .mul(sharesMatched)
          .div(oldestLot.remainingShares);
        oldestLot.remainingShares =
          oldestLot.remainingShares.minus(sharesMatched);
        oldestLot.remainingCostBasis =
          oldestLot.remainingCostBasis.minus(allocatedCostBasis);
        oldestLot.costPerShare =
          safeDivide(oldestLot.remainingCostBasis, oldestLot.remainingShares) ??
          oldestLot.costPerShare;

        if (oldestLot.remainingCostBasisInBase !== null) {
          allocatedCostBasisInBase = oldestLot.remainingCostBasisInBase
            .mul(sharesMatched)
            .div(oldestLot.remainingShares.plus(sharesMatched));
          oldestLot.remainingCostBasisInBase =
            oldestLot.remainingCostBasisInBase.minus(allocatedCostBasisInBase);
        } else {
          allocatedCostBasisInBase = null;
        }
      }

      // Allocate proceeds and sell commission across lots; the final lot match
      // absorbs any rounding remainder so lot matches sum to the exact trade.
      let lotGrossProceeds: DecimalValue;
      let lotCommission: DecimalValue;
      let lotNetProceeds: DecimalValue;

      if (isFinalMatchForThisSell) {
        lotGrossProceeds = remainingGrossProceeds;
        lotCommission = remainingCommission;
        lotNetProceeds = remainingNetProceeds;
        remainingToMatch = ZERO;
      } else {
        lotGrossProceeds = totalGrossProceeds
          .mul(sharesMatched)
          .div(actualSharesToSell);
        lotCommission = totalSellCommission
          .mul(sharesMatched)
          .div(actualSharesToSell);
        lotNetProceeds = lotGrossProceeds.minus(lotCommission);
        remainingToMatch = remainingToMatch.minus(sharesMatched);
        remainingGrossProceeds = remainingGrossProceeds.minus(lotGrossProceeds);
        remainingCommission = remainingCommission.minus(lotCommission);
        remainingNetProceeds = remainingNetProceeds.minus(lotNetProceeds);
      }

      const lotRealizedPnl = lotNetProceeds.minus(allocatedCostBasis);
      tradeRealizedPnl = tradeRealizedPnl.plus(lotRealizedPnl);

      const netProceedsInBase =
        sellFxRate !== null ? lotNetProceeds.mul(sellFxRate) : null;
      const realizedPnlInBase =
        netProceedsInBase !== null && allocatedCostBasisInBase !== null
          ? netProceedsInBase.minus(allocatedCostBasisInBase)
          : null;

      closedLotMatches.push({
        buyTransactionId: oldestLot.buyTransactionId,
        sellTransactionId: tx.id,
        openedAt: oldestLot.openedAt,
        closedAt: tx.executedAt,
        sharesMatched,
        costBasis: allocatedCostBasis,
        grossProceeds: lotGrossProceeds,
        commissionAllocated: lotCommission,
        netProceeds: lotNetProceeds,
        realizedPnl: lotRealizedPnl,
        costBasisInBase: allocatedCostBasisInBase,
        netProceedsInBase,
        realizedPnlInBase,
      });
    }

    closedTradeCount += 1;
    if (tradeRealizedPnl.gt(ZERO)) {
      winningTradeCount += 1;
    }
  }

  // Apply any splits occurring after the final transaction up through `asOfDate`.
  applySplitsUpTo(asOfDate ?? "9999-12-31");

  const sharesHeld = sumOpenShares(openLots);

  let openCostBasis = ZERO;
  let openCostBasisInBase: DecimalValue | null = options.baseCurrency
    ? ZERO
    : null;
  for (const lot of openLots) {
    openCostBasis = openCostBasis.plus(lot.remainingCostBasis);
    if (openCostBasisInBase !== null) {
      if (lot.remainingCostBasisInBase === null) {
        openCostBasisInBase = null;
      } else {
        openCostBasisInBase = openCostBasisInBase.plus(
          lot.remainingCostBasisInBase,
        );
      }
    }
  }

  let realizedPnl = ZERO;
  let realizedPnlInBase: DecimalValue | null = options.baseCurrency
    ? ZERO
    : null;
  for (const match of closedLotMatches) {
    realizedPnl = realizedPnl.plus(match.realizedPnl);
    if (realizedPnlInBase !== null) {
      if (match.realizedPnlInBase === null) {
        realizedPnlInBase = null;
      } else {
        realizedPnlInBase = realizedPnlInBase.plus(match.realizedPnlInBase);
      }
    }
  }

  let dividendsReceived = ZERO;
  let dividendsReceivedInBase: DecimalValue | null = options.baseCurrency
    ? ZERO
    : null;
  for (const dividend of dividends) {
    dividendsReceived = dividendsReceived.plus(dividend.netAmount);
    if (dividendsReceivedInBase !== null) {
      if (dividend.netAmountInBase === null) {
        dividendsReceivedInBase = null;
      } else {
        dividendsReceivedInBase = dividendsReceivedInBase.plus(
          dividend.netAmountInBase,
        );
      }
    }
  }

  return {
    openLots,
    closedLotMatches,
    dividends,
    sharesHeld,
    openCostBasis,
    openCostBasisInBase,
    totalCapitalInvested,
    realizedPnl,
    realizedPnlInBase,
    dividendsReceived,
    dividendsReceivedInBase,
    closedTradeCount,
    winningTradeCount,
    zeroCostBuys,
    missingFxFlags,
    validationIssues,
  };
}
