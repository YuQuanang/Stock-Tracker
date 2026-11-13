"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useMemo, useState } from "react";
import {
  ArrowLeft,
  Pencil,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Split,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { InteractivePriceChart } from "@/components/charts/interactive-price-chart";
import { TransactionSheet } from "@/components/transactions/transaction-sheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { GainBadge } from "@/components/ui/gain-badge";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet } from "@/components/ui/sheet";
import { useQuotesPoll } from "@/hooks/use-quotes-poll";
import {
  HUNDRED,
  safeDivide,
  toDecimal,
  toDecimalString,
  toNullableDecimalString,
} from "@/lib/finance";
import {
  formatCompactMoney,
  formatCompactNumber,
  formatMoney,
  formatPercent,
  formatQuantity,
} from "@/lib/format";
import {
  buildValuedHoldings,
  type SerializedOpenLot,
} from "@/lib/holdings/valuation";
import type { StockDetailSnapshot } from "@/lib/services/holdings";
import type {
  EnrichedTransactionRow,
  LedgerPositionSummary,
} from "@/lib/services/ledger";
import {
  formatExchangeCodeForDisplay,
  formatSymbolForDisplay,
} from "@/lib/transactions/form-logic";

type DetailLedgerTab = "lots" | "closed" | "transactions";

interface ComputedOpenLot extends SerializedOpenLot {
  liveValue: string | null;
  unrealizedPnl: string | null;
  unrealizedPnlPercent: string | null;
}

function compute52WeekPercentPosition(params: {
  currentPrice: string | null;
  low: string | null;
  high: string | null;
}): number | null {
  if (!params.currentPrice || !params.low || !params.high) {
    return null;
  }
  const price = Number(params.currentPrice);
  const low = Number(params.low);
  const high = Number(params.high);
  if (
    !Number.isFinite(price) ||
    !Number.isFinite(low) ||
    !Number.isFinite(high) ||
    high <= low
  ) {
    return null;
  }
  const rawPct = ((price - low) / (high - low)) * 100;
  return Math.max(0, Math.min(100, rawPct));
}

export function StockDetailView({
  instrument,
  portfolios,
  buckets,
  transactions,
  corporateActions,
  initialQuote,
  initialFxUsdToSgd,
  initialMarket,
  fundamentals,
  initialHistory,
  baseCurrency,
}: StockDetailSnapshot) {
  const router = useRouter();

  const [selectedPortfolioId, setSelectedPortfolioId] = useState<string>("all");
  const [ledgerTab, setLedgerTab] = useState<DetailLedgerTab>(() => {
    const hasOpen = buckets.some((b) => b.openLots.length > 0);
    if (hasOpen) {
      return "lots";
    }
    const hasClosed = buckets.some((b) => b.closedLotMatches.length > 0);
    if (hasClosed) {
      return "closed";
    }
    return "transactions";
  });

  // Transaction sheet state (create or edit)
  const [isTxSheetOpen, setIsTxSheetOpen] = useState(false);
  const [editingTx, setEditingTx] = useState<EnrichedTransactionRow | null>(
    null,
  );

  // Delete confirmation state
  const [confirmDeleteTxId, setConfirmDeleteTxId] = useState<string | null>(
    null,
  );
  const [deletingTxId, setDeletingTxId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Manual Price / Worthless Override sheet state
  const [isOverrideOpen, setIsOverrideOpen] = useState(false);
  const [manualPriceInput, setManualPriceInput] = useState<string>(
    instrument.manualPrice ?? "",
  );
  const [isDelistedInput, setIsDelistedInput] = useState<boolean>(
    instrument.isDelisted,
  );
  const [isSavingOverride, setIsSavingOverride] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);

  const initialQuotesMap = useMemo(
    () => (initialQuote ? { [instrument.symbol]: initialQuote } : {}),
    [initialQuote, instrument.symbol],
  );

  const { quotes, fxUsdToSgd, isRefreshing, isRetrying, refreshNow, retrySymbols } =
    useQuotesPoll({
      symbols: [instrument.symbol],
      includeSparklines: true,
      enabled:
        instrument.assetType !== "crypto" &&
        !instrument.isDelisted &&
        !instrument.priceNotFound &&
        !initialQuote?.priceNotFound &&
        initialQuote?.status !== "unavailable",
      initialQuotes: initialQuotesMap,
      initialFxUsdToSgd,
      initialMarket,
    });

  const liveQuote = quotes[instrument.symbol] ?? initialQuote;

  const { rows: valuedRows } = useMemo(
    () =>
      buildValuedHoldings({
        buckets,
        portfolioFilterId: selectedPortfolioId,
        quotes,
        usdToSgdRate: fxUsdToSgd?.rate ?? null,
        baseCurrency,
      }),
    [buckets, selectedPortfolioId, quotes, fxUsdToSgd?.rate, baseCurrency],
  );

  const valuedRow = valuedRows[0];

  // Effective unit price (respects delisted $0 / manual override / live quote)
  const effectiveUnitPrice = useMemo(() => {
    if (valuedRow) {
      return valuedRow.unitPrice;
    }
    if (instrument.isDelisted) {
      return instrument.manualPrice ?? "0";
    }
    if (instrument.manualPrice !== null) {
      return instrument.manualPrice;
    }
    return liveQuote?.price ?? null;
  }, [valuedRow, instrument.isDelisted, instrument.manualPrice, liveQuote?.price]);

  const effectiveFreshnessLabel = useMemo(() => {
    if (valuedRow) {
      return valuedRow.freshnessLabel;
    }
    if (instrument.isDelisted) {
      return instrument.manualPrice
        ? "Marked delisted (manual)"
        : "Marked worthless ($0)";
    }
    if (instrument.manualPrice !== null) {
      return "Manual price";
    }
    return liveQuote?.freshnessLabel ?? "Price unavailable";
  }, [
    valuedRow,
    instrument.isDelisted,
    instrument.manualPrice,
    liveQuote?.freshnessLabel,
  ]);

  // Portfolios in which this instrument appears
  const symbolPortfolios = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of buckets) {
      map.set(b.portfolioId, b.portfolioName);
    }
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  }, [buckets]);

  const filteredBuckets = useMemo(
    () =>
      selectedPortfolioId === "all"
        ? buckets
        : buckets.filter((b) => b.portfolioId === selectedPortfolioId),
    [buckets, selectedPortfolioId],
  );

  const computedOpenLots = useMemo<ComputedOpenLot[]>(() => {
    const unitPriceDec =
      effectiveUnitPrice !== null ? toDecimal(effectiveUnitPrice) : null;

    const lots: ComputedOpenLot[] = [];
    for (const bucket of filteredBuckets) {
      for (const lot of bucket.openLots) {
        const sharesDec = toDecimal(lot.remainingShares);
        const costDec = toDecimal(lot.remainingCostBasis);

        if (unitPriceDec !== null) {
          const liveVal = sharesDec.mul(unitPriceDec);
          const pnl = liveVal.minus(costDec);
          const pnlPct = safeDivide(pnl.mul(HUNDRED), costDec);
          lots.push({
            ...lot,
            liveValue: toDecimalString(liveVal, 6),
            unrealizedPnl: toDecimalString(pnl, 6),
            unrealizedPnlPercent: toNullableDecimalString(pnlPct, 2),
          });
        } else {
          lots.push({
            ...lot,
            liveValue: null,
            unrealizedPnl: null,
            unrealizedPnlPercent: null,
          });
        }
      }
    }

    return lots.sort((a, b) => a.localDate.localeCompare(b.localDate));
  }, [filteredBuckets, effectiveUnitPrice]);

  const filteredClosedMatches = useMemo(() => {
    const matches = filteredBuckets.flatMap((b) => b.closedLotMatches);
    return matches.sort((a, b) => b.sellDate.localeCompare(a.sellDate));
  }, [filteredBuckets]);

  const filteredTransactions = useMemo(
    () =>
      selectedPortfolioId === "all"
        ? transactions
        : transactions.filter((tx) => tx.portfolioId === selectedPortfolioId),
    [transactions, selectedPortfolioId],
  );

  const sheetPositions = useMemo<LedgerPositionSummary[]>(
    () =>
      buckets.map((b) => ({
        portfolioId: b.portfolioId,
        portfolioName: b.portfolioName,
        instrumentId: b.instrumentId,
        symbol: b.symbol,
        instrumentName: b.name,
        currency: b.currency,
        sharesHeld: b.sharesHeld,
        averageCostPerShare: null,
        openCostBasis: b.openCostBasis,
        realizedPnl: b.realizedPnl,
        dividendsReceived: b.dividendsReceived,
        closedTradeCount: b.closedTradeCount,
        zeroCostBuyCount: b.zeroCostBuyCount,
      })),
    [buckets],
  );

  const ledgerTabOptions = useMemo(
    () => [
      {
        value: "lots" as DetailLedgerTab,
        label: `Open Lots (${computedOpenLots.length})`,
      },
      {
        value: "closed" as DetailLedgerTab,
        label: `Closed Trades (${filteredClosedMatches.length})`,
      },
      {
        value: "transactions" as DetailLedgerTab,
        label: `Transactions (${filteredTransactions.length})`,
      },
    ],
    [
      computedOpenLots.length,
      filteredClosedMatches.length,
      filteredTransactions.length,
    ],
  );

  const rangePositionPct = useMemo(
    () =>
      compute52WeekPercentPosition({
        currentPrice: effectiveUnitPrice,
        low: fundamentals.fiftyTwoWeekLow,
        high: fundamentals.fiftyTwoWeekHigh,
      }),
    [
      effectiveUnitPrice,
      fundamentals.fiftyTwoWeekLow,
      fundamentals.fiftyTwoWeekHigh,
    ],
  );

  const exchangeDisplay =
    formatExchangeCodeForDisplay(
      instrument.exchangeCode ?? fundamentals.exchangeName,
    ) ||
    fundamentals.exchangeName ||
    null;

  function openNewTradeSheet(): void {
    setEditingTx(null);
    setIsTxSheetOpen(true);
  }

  function openEditTradeSheet(tx: EnrichedTransactionRow): void {
    setEditingTx(tx);
    setIsTxSheetOpen(true);
  }

  function openOverrideSheet(): void {
    setManualPriceInput(instrument.manualPrice ?? "");
    setIsDelistedInput(instrument.isDelisted);
    setOverrideError(null);
    setIsOverrideOpen(true);
  }

  async function saveOverride(params: {
    manualPrice: string | null;
    isDelisted: boolean;
  }): Promise<void> {
    setIsSavingOverride(true);
    setOverrideError(null);
    try {
      const response = await fetch(
        `/api/instruments/${encodeURIComponent(instrument.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
        },
      );

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setOverrideError(
          body?.error ?? "Could not update price override. Check the input.",
        );
        return;
      }

      setIsOverrideOpen(false);
      router.refresh();
    } catch {
      setOverrideError("Could not reach the server. Check your connection.");
    } finally {
      setIsSavingOverride(false);
    }
  }

  function handleOverrideSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = manualPriceInput.trim();
    if (trimmed !== "") {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setOverrideError("Manual price must be a non-negative number.");
        return;
      }
    }
    void saveOverride({
      manualPrice: trimmed === "" ? null : trimmed,
      isDelisted: isDelistedInput,
    });
  }

  async function handleDeleteTransaction(txId: string): Promise<void> {
    setDeletingTxId(txId);
    setDeleteError(null);
    try {
      const response = await fetch(
        `/api/transactions/${encodeURIComponent(txId)}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setDeleteError(body?.error ?? "Could not delete transaction.");
        return;
      }
      setConfirmDeleteTxId(null);
      router.refresh();
    } catch {
      setDeleteError("Could not reach the server to delete transaction.");
    } finally {
      setDeletingTxId(null);
    }
  }

  const hasActiveOverride =
    instrument.isDelisted || instrument.manualPrice !== null;

  return (
    <div className="space-y-6">
      {/* Top Breadcrumb + Action Bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Link
          href="/holdings"
          className="inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1.5 -ml-2.5 text-[14px] font-medium text-accent transition-colors hover:bg-accent/8"
        >
          <ArrowLeft size={16} strokeWidth={2.1} aria-hidden="true" />
          <span>Holdings</span>
        </Link>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={openOverrideSheet}
          >
            <SlidersHorizontal size={14} strokeWidth={2} aria-hidden="true" />
            <span>
              {hasActiveOverride ? "Override active" : "Price override"}
            </span>
          </Button>

          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              if (
                instrument.priceNotFound ||
                liveQuote?.priceNotFound ||
                liveQuote?.status === "unavailable"
              ) {
                void retrySymbols([instrument.symbol]).then((res) => {
                  const updated = res?.[instrument.symbol];
                  if (updated && updated.price !== null) {
                    router.refresh();
                  }
                });
              } else {
                void refreshNow();
              }
            }}
            disabled={isRefreshing || isRetrying}
          >
            <RefreshCw
              size={14}
              strokeWidth={2}
              aria-hidden="true"
              className={isRefreshing || isRetrying ? "animate-spin" : undefined}
            />
            <span>
              {isRefreshing || isRetrying
                ? "Checking…"
                : instrument.priceNotFound || liveQuote?.priceNotFound
                  ? "Retry lookup"
                  : "Refresh"}
            </span>
          </Button>

          <Button
            size="sm"
            onClick={openNewTradeSheet}
          >
            <Plus size={16} strokeWidth={2.2} aria-hidden="true" />
            <span>Record trade</span>
          </Button>
        </div>
      </div>

      {/* Hero Header Card: Symbol, Identity & Live Quote */}
      <Card className="p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-mono text-[28px] font-bold tracking-tight text-ink sm:text-[32px]">
                {formatSymbolForDisplay(instrument.symbol)}
              </h1>

              {exchangeDisplay && (
                <span className="rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-[11.5px] font-medium text-ink-2">
                  {exchangeDisplay}
                </span>
              )}

              <span className="rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-[11.5px] font-medium text-ink-2">
                {instrument.currency}
              </span>

              <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-ink-3">
                {instrument.assetType}
              </span>

              {hasActiveOverride && (
                <span className="rounded-full bg-accent/12 px-2.5 py-0.5 text-[11.5px] font-medium text-accent">
                  {instrument.isDelisted
                    ? "Delisted / Worthless override"
                    : "Manual price override"}
                </span>
              )}
            </div>

            <p className="mt-1 text-[15.5px] text-ink-2">
              {instrument.name ?? fundamentals.name ?? "Unnamed instrument"}
            </p>
          </div>

          <div className="sm:text-right">
            {effectiveUnitPrice !== null ? (
              <>
                <p className="num text-[28px] font-semibold tracking-tight text-ink sm:text-[32px]">
                  {formatMoney(effectiveUnitPrice, instrument.currency, {
                    maximumFractionDigits: 4,
                  })}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-2 sm:justify-end">
                  {!hasActiveOverride && (
                    <GainBadge
                      amount={liveQuote?.dayChange ?? null}
                      currency={instrument.currency}
                      percent={liveQuote?.dayChangePercent ?? null}
                      size="sm"
                      pill
                    />
                  )}
                  <span className="text-[12px] text-ink-3">
                    {effectiveFreshnessLabel}
                  </span>
                </div>
              </>
            ) : (
              <div>
                <p className="text-[20px] font-semibold text-ink-2">
                  {instrument.priceNotFound || liveQuote?.priceNotFound
                    ? "Price not found"
                    : "Price unavailable"}
                </p>
                <p className="mt-1 text-[12.5px] text-ink-3">
                  {liveQuote?.unavailableReason ??
                    instrument.priceNotFoundReason ??
                    "No market quote available. Use Price override to value manually."}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Portfolio Scope Pills (when held/traded in 1+ portfolios) */}
        {symbolPortfolios.length > 1 && (
          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <span className="text-[12px] font-medium text-ink-3">
              Portfolio scope:
            </span>
            <button
              type="button"
              onClick={() => setSelectedPortfolioId("all")}
              className={`rounded-full px-3 py-1 text-[12.5px] font-medium transition-colors ${
                selectedPortfolioId === "all"
                  ? "bg-accent text-white"
                  : "bg-surface-2 text-ink-2 hover:text-ink"
              }`}
            >
              All portfolios ({symbolPortfolios.length})
            </button>
            {symbolPortfolios.map((pf) => (
              <button
                key={pf.id}
                type="button"
                onClick={() => setSelectedPortfolioId(pf.id)}
                className={`rounded-full px-3 py-1 text-[12.5px] font-medium transition-colors ${
                  selectedPortfolioId === pf.id
                    ? "bg-accent text-white"
                    : "bg-surface-2 text-ink-2 hover:text-ink"
                }`}
              >
                {pf.name}
              </button>
            ))}
          </div>
        )}
      </Card>

      {/* Interactive Price Chart with Range Selector, Avg Cost Line & Trade Markers */}
      <InteractivePriceChart
        symbol={instrument.symbol}
        currency={instrument.currency}
        initialHistory={initialHistory}
        averageCostPerShare={valuedRow?.averageCostPerShare ?? null}
        transactions={filteredTransactions}
      />

      {/* Position Summary + Company / ETF Key Statistics */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Card 1: Your Position Summary */}
        <Card className="p-5 sm:p-6">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[16px] font-semibold tracking-tight text-ink">
              Position Summary
            </h2>
            {valuedRow?.weightPercent && valuedRow.isOpenPosition && (
              <span className="num rounded-full bg-surface-2 px-2.5 py-0.5 text-[12px] font-medium text-ink-2">
                {formatPercent(valuedRow.weightPercent, { fractionDigits: 1 })}{" "}
                of portfolio
              </span>
            )}
          </div>

          {!valuedRow ? (
            <div className="mt-6 rounded-[14px] border border-dashed border-line px-4 py-8 text-center">
              <p className="text-[14px] font-medium text-ink-2">
                No recorded position in this scope
              </p>
              <p className="mt-1 text-[12.5px] text-ink-3">
                Record a Buy transaction to track FIFO lots, cost basis, and
                realized/unrealized P&L.
              </p>
            </div>
          ) : (
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4 border-t border-line pt-4 text-[13.5px]">
              <div>
                <dt className="text-[12px] text-ink-3">Shares held</dt>
                <dd className="num mt-0.5 text-[16px] font-semibold text-ink">
                  {formatQuantity(valuedRow.sharesHeld)}
                </dd>
              </div>

              <div>
                <dt className="text-[12px] text-ink-3">Avg cost / share</dt>
                <dd className="num mt-0.5 text-[16px] font-semibold text-ink">
                  {formatMoney(
                    valuedRow.averageCostPerShare,
                    instrument.currency,
                    { maximumFractionDigits: 4 },
                  )}
                </dd>
              </div>

              <div className="border-t border-line/70 pt-3.5">
                <dt className="text-[12px] text-ink-3">Market value</dt>
                <dd className="num mt-0.5 text-[15.5px] font-semibold text-ink">
                  {valuedRow.marketValue
                    ? formatMoney(valuedRow.marketValue, instrument.currency)
                    : "Price unavailable"}
                </dd>
                {instrument.currency !== baseCurrency &&
                  valuedRow.marketValueInBase && (
                    <p className="num mt-0.5 text-[12px] text-ink-3">
                      {formatMoney(valuedRow.marketValueInBase, baseCurrency)}
                    </p>
                  )}
              </div>

              <div className="border-t border-line/70 pt-3.5">
                <dt className="text-[12px] text-ink-3">Open cost basis</dt>
                <dd className="num mt-0.5 text-[15.5px] font-semibold text-ink">
                  {formatMoney(valuedRow.costBasis, instrument.currency)}
                </dd>
                {instrument.currency !== baseCurrency &&
                  valuedRow.costBasisInBase && (
                    <p className="num mt-0.5 text-[12px] text-ink-3">
                      {formatMoney(valuedRow.costBasisInBase, baseCurrency)} at
                      purchase FX
                    </p>
                  )}
              </div>

              <div className="border-t border-line/70 pt-3.5">
                <dt className="text-[12px] text-ink-3">Unrealized P&L</dt>
                <dd className="mt-1">
                  <GainBadge
                    amount={valuedRow.unrealizedPnl}
                    currency={instrument.currency}
                    percent={valuedRow.unrealizedPnlPercent}
                    size="sm"
                  />
                </dd>
                {instrument.currency !== baseCurrency &&
                  valuedRow.unrealizedPnlInBase && (
                    <p className="num mt-0.5 text-[12px] text-ink-3">
                      {formatMoney(
                        valuedRow.unrealizedPnlInBase,
                        baseCurrency,
                        { signed: true },
                      )}
                    </p>
                  )}
              </div>

              <div className="border-t border-line/70 pt-3.5">
                <dt className="text-[12px] text-ink-3">Realized P&L</dt>
                <dd className="mt-1">
                  <GainBadge
                    amount={valuedRow.realizedPnl}
                    currency={instrument.currency}
                    size="sm"
                  />
                </dd>
                <p className="num mt-0.5 text-[12px] text-ink-3">
                  {valuedRow.closedTradeCount > 0
                    ? `Won ${valuedRow.winningTradeCount}/${valuedRow.closedTradeCount} closed trades`
                    : "No closed trades yet"}
                </p>
              </div>

              <div className="border-t border-line/70 pt-3.5">
                <dt className="text-[12px] text-ink-3">Dividends received</dt>
                <dd className="num mt-0.5 text-[15.5px] font-semibold text-ink">
                  {formatMoney(
                    valuedRow.dividendsReceived,
                    instrument.currency,
                  )}
                </dd>
                {instrument.currency !== baseCurrency &&
                  valuedRow.dividendsReceivedInBase && (
                    <p className="num mt-0.5 text-[12px] text-ink-3">
                      {formatMoney(
                        valuedRow.dividendsReceivedInBase,
                        baseCurrency,
                      )}
                    </p>
                  )}
              </div>

              <div className="border-t border-line/70 pt-3.5">
                <dt className="text-[12px] text-ink-3">Total lifetime return</dt>
                <dd className="mt-1">
                  <GainBadge
                    amount={valuedRow.totalReturn}
                    currency={instrument.currency}
                    percent={valuedRow.totalReturnPercent}
                    size="sm"
                  />
                </dd>
                {instrument.currency !== baseCurrency &&
                  valuedRow.totalReturnInBase && (
                    <p className="num mt-0.5 text-[12px] text-ink-3">
                      {formatMoney(valuedRow.totalReturnInBase, baseCurrency, {
                        signed: true,
                      })}
                    </p>
                  )}
              </div>
            </dl>
          )}
        </Card>

        {/* Card 2: Key Statistics & 52-Week Range Bar */}
        <Card className="p-5 sm:p-6">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[16px] font-semibold tracking-tight text-ink">
              Key Statistics
            </h2>
            {fundamentals.source && (
              <span className="text-[11.5px] text-ink-3">
                24h cache · {fundamentals.source}
              </span>
            )}
          </div>

          {/* 52-Week Range Visual Indicator */}
          <div className="mt-4 rounded-[13px] bg-surface-2/75 p-3.5">
            <div className="flex items-center justify-between text-[12px] font-medium text-ink-3">
              <span>52-Week Low</span>
              <span>52-Week Range</span>
              <span>52-Week High</span>
            </div>

            {fundamentals.fiftyTwoWeekLow && fundamentals.fiftyTwoWeekHigh ? (
              <>
                <div className="relative mt-2.5 h-2 w-full rounded-full bg-line">
                  <div
                    className="h-full rounded-full bg-accent/35"
                    style={{
                      width: `${rangePositionPct ?? 0}%`,
                    }}
                  />
                  {rangePositionPct !== null && (
                    <span
                      aria-hidden="true"
                      className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-accent shadow-xs"
                      style={{ left: `${rangePositionPct}%` }}
                    />
                  )}
                </div>
                <div className="num mt-2 flex items-center justify-between text-[13px] font-semibold text-ink">
                  <span>
                    {formatMoney(
                      fundamentals.fiftyTwoWeekLow,
                      instrument.currency,
                    )}
                  </span>
                  <span>
                    {formatMoney(
                      fundamentals.fiftyTwoWeekHigh,
                      instrument.currency,
                    )}
                  </span>
                </div>
              </>
            ) : (
              <p className="mt-2 text-[12.5px] text-ink-3">
                52-week range unavailable for this instrument.
              </p>
            )}
          </div>

          {/* Key-Value Fundamental Rows */}
          <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3.5 text-[13.5px]">
            <div className="flex items-baseline justify-between gap-2 border-b border-line/70 pb-2.5">
              <dt className="text-ink-3">Market Cap</dt>
              <dd className="num font-medium text-ink">
                {formatCompactMoney(
                  fundamentals.marketCap,
                  fundamentals.currency,
                )}
              </dd>
            </div>

            <div className="flex items-baseline justify-between gap-2 border-b border-line/70 pb-2.5">
              <dt className="text-ink-3">P/E (TTM)</dt>
              <dd className="num font-medium text-ink">
                {fundamentals.peTrailing
                  ? Number(fundamentals.peTrailing).toFixed(2)
                  : "—"}
              </dd>
            </div>

            <div className="flex items-baseline justify-between gap-2 border-b border-line/70 pb-2.5">
              <dt className="text-ink-3">Div Yield</dt>
              <dd className="num font-medium text-ink">
                {fundamentals.dividendYieldPercent
                  ? formatPercent(fundamentals.dividendYieldPercent)
                  : "—"}
              </dd>
            </div>

            <div className="flex items-baseline justify-between gap-2 border-b border-line/70 pb-2.5">
              <dt className="text-ink-3">Beta</dt>
              <dd className="num font-medium text-ink">
                {fundamentals.beta ? Number(fundamentals.beta).toFixed(2) : "—"}
              </dd>
            </div>

            <div className="flex items-baseline justify-between gap-2 border-b border-line/70 pb-2.5">
              <dt className="text-ink-3">30D Avg Vol</dt>
              <dd className="num font-medium text-ink">
                {formatCompactNumber(fundamentals.averageVolume)}
              </dd>
            </div>

            <div className="flex items-baseline justify-between gap-2 border-b border-line/70 pb-2.5">
              <dt className="text-ink-3">Exchange</dt>
              <dd className="truncate font-medium text-ink">
                {exchangeDisplay ?? "—"}
              </dd>
            </div>

            <div className="col-span-2 flex items-baseline justify-between gap-3 pt-0.5">
              <dt className="shrink-0 text-ink-3">Sector / Industry</dt>
              <dd className="truncate text-right font-medium text-ink">
                {fundamentals.industry ?? fundamentals.sector ?? "—"}
              </dd>
            </div>
          </dl>
        </Card>
      </div>

      {/* Corporate Split Banner (when applicable) */}
      {corporateActions.length > 0 && (
        <Card className="flex items-start gap-3 px-4 py-3.5 sm:px-5">
          <Split
            size={17}
            className="mt-0.5 shrink-0 text-accent"
            aria-hidden="true"
          />
          <div className="text-[13px] leading-relaxed text-ink-2">
            <span className="font-semibold text-ink">
              Stock splits applied to FIFO lots:{" "}
            </span>
            {corporateActions.map((split, idx) => (
              <span key={split.id} className="num">
                {idx > 0 ? " · " : ""}
                {split.ratioNumerator}:{split.ratioDenominator} on{" "}
                {split.exDate}
              </span>
            ))}
          </div>
        </Card>
      )}

      {/* Segmented FIFO Lots / Closed Trades / Transactions Breakdown */}
      <div className="space-y-3.5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <SegmentedControl
            ariaLabel="Position ledger breakdown"
            options={ledgerTabOptions}
            value={ledgerTab}
            onChange={setLedgerTab}
            layoutId="stock-detail-ledger-tabs"
          />

          {deleteError && (
            <p className="flex items-center gap-1.5 text-[13px] text-loss">
              <TriangleAlert size={14} aria-hidden="true" />
              <span>{deleteError}</span>
            </p>
          )}
        </div>

        {/* TAB 1: OPEN FIFO LOTS */}
        {ledgerTab === "lots" && (
          <Card className="overflow-hidden">
            {computedOpenLots.length === 0 ? (
              <div className="px-4 py-10 text-center text-[14px] text-ink-3">
                No open FIFO lots for {instrument.symbol} in this scope.
              </div>
            ) : (
              <>
                {/* Mobile Open Lots Cards */}
                <div className="divide-y divide-line md:hidden">
                  {computedOpenLots.map((lot) => (
                    <div
                      key={`${lot.portfolioId}-${lot.buyTransactionId}`}
                      className="space-y-2 px-4 py-3.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <p className="num text-[14px] font-semibold text-ink">
                            {lot.localDate}
                          </p>
                          <p className="text-[12px] text-ink-3">
                            {lot.portfolioName}
                            {lot.isZeroCostBuy ? " · Zero-cost lot" : ""}
                          </p>
                        </div>
                        <GainBadge
                          amount={lot.unrealizedPnl}
                          currency={instrument.currency}
                          percent={lot.unrealizedPnlPercent}
                          size="sm"
                        />
                      </div>

                      <div className="num flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-ink-2">
                        <span>
                          {formatQuantity(lot.remainingShares)} sh @{" "}
                          {formatMoney(lot.costPerShare, instrument.currency, {
                            maximumFractionDigits: 4,
                          })}
                        </span>
                        <span>
                          Value{" "}
                          {lot.liveValue
                            ? formatMoney(lot.liveValue, instrument.currency)
                            : "—"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Desktop Open Lots Table */}
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full border-collapse text-left text-[13.5px]">
                    <thead>
                      <tr className="border-b border-line text-[11.5px] font-medium uppercase tracking-wide text-ink-3">
                        <th className="px-4 py-3">Purchase Date</th>
                        <th className="px-3 py-3">Portfolio</th>
                        <th className="px-3 py-3 text-right">
                          Remaining / Initial
                        </th>
                        <th className="px-3 py-3 text-right">Cost / Share</th>
                        <th className="px-3 py-3 text-right">Cost Basis</th>
                        <th className="px-3 py-3 text-right">Live Value</th>
                        <th className="px-4 py-3 text-right">Unrealized P&L</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {computedOpenLots.map((lot) => (
                        <tr
                          key={`${lot.portfolioId}-${lot.buyTransactionId}`}
                          className="hover:bg-surface-2/45"
                        >
                          <td className="num whitespace-nowrap px-4 py-3.5 font-medium text-ink">
                            {lot.localDate}
                            {lot.isZeroCostBuy && (
                              <span className="ml-2 rounded bg-accent/12 px-1.5 py-0.5 font-sans text-[10.5px] font-medium text-accent">
                                Zero cost
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-3.5 text-ink-2">
                            {lot.portfolioName}
                          </td>
                          <td className="num whitespace-nowrap px-3 py-3.5 text-right text-ink">
                            <span className="font-medium">
                              {formatQuantity(lot.remainingShares)}
                            </span>{" "}
                            <span className="text-[12px] text-ink-3">
                              / {formatQuantity(lot.initialShares)}
                            </span>
                          </td>
                          <td className="num whitespace-nowrap px-3 py-3.5 text-right text-ink">
                            {formatMoney(
                              lot.costPerShare,
                              instrument.currency,
                              { maximumFractionDigits: 4 },
                            )}
                          </td>
                          <td className="num whitespace-nowrap px-3 py-3.5 text-right">
                            <div className="font-medium text-ink">
                              {formatMoney(
                                lot.remainingCostBasis,
                                instrument.currency,
                              )}
                            </div>
                            {instrument.currency !== baseCurrency &&
                              lot.remainingCostBasisInBase && (
                                <div className="text-[11.5px] text-ink-3">
                                  {formatMoney(
                                    lot.remainingCostBasisInBase,
                                    baseCurrency,
                                  )}
                                  {lot.fxRateToBase
                                    ? ` @ ${Number(lot.fxRateToBase).toFixed(4)}`
                                    : ""}
                                </div>
                              )}
                          </td>
                          <td className="num whitespace-nowrap px-3 py-3.5 text-right font-medium text-ink">
                            {lot.liveValue
                              ? formatMoney(lot.liveValue, instrument.currency)
                              : "—"}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3.5 text-right">
                            <GainBadge
                              amount={lot.unrealizedPnl}
                              currency={instrument.currency}
                              percent={lot.unrealizedPnlPercent}
                              size="sm"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Card>
        )}

        {/* TAB 2: CLOSED FIFO LOT MATCHES */}
        {ledgerTab === "closed" && (
          <Card className="overflow-hidden">
            {filteredClosedMatches.length === 0 ? (
              <div className="px-4 py-10 text-center text-[14px] text-ink-3">
                No closed FIFO trades for {instrument.symbol} in this scope.
              </div>
            ) : (
              <>
                {/* Mobile Closed Trades Cards */}
                <div className="divide-y divide-line md:hidden">
                  {filteredClosedMatches.map((match, idx) => (
                    <div
                      key={`${match.sellTransactionId}-${match.buyTransactionId}-${idx}`}
                      className="space-y-2 px-4 py-3.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <p className="num text-[13.5px] font-semibold text-ink">
                            {match.buyDate} → {match.sellDate}
                          </p>
                          <p className="text-[12px] text-ink-3">
                            {match.portfolioName} ·{" "}
                            {formatQuantity(match.sharesMatched)} sh
                            {match.closedViaPortfolioName
                              ? ` · Closed by Sell All in ${match.closedViaPortfolioName}`
                              : ""}
                          </p>
                        </div>
                        <GainBadge
                          amount={match.realizedPnl}
                          currency={instrument.currency}
                          percent={match.realizedPnlPercent}
                          size="sm"
                        />
                      </div>

                      <div className="num flex items-center justify-between text-[12px] text-ink-3">
                        <span>
                          Cost{" "}
                          {formatMoney(
                            match.allocatedCostBasis,
                            instrument.currency,
                          )}
                        </span>
                        <span>
                          Proceeds{" "}
                          {formatMoney(
                            match.netSaleProceeds,
                            instrument.currency,
                          )}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Desktop Closed Trades Table */}
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full border-collapse text-left text-[13.5px]">
                    <thead>
                      <tr className="border-b border-line text-[11.5px] font-medium uppercase tracking-wide text-ink-3">
                        <th className="px-4 py-3">Holding Period</th>
                        <th className="px-3 py-3">Portfolio</th>
                        <th className="px-3 py-3 text-right">Shares Matched</th>
                        <th className="px-3 py-3 text-right">Cost Basis</th>
                        <th className="px-3 py-3 text-right">Net Proceeds</th>
                        <th className="px-4 py-3 text-right">Realized P&L</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {filteredClosedMatches.map((match, idx) => (
                        <tr
                          key={`${match.sellTransactionId}-${match.buyTransactionId}-${idx}`}
                          className="hover:bg-surface-2/45"
                        >
                          <td className="num whitespace-nowrap px-4 py-3.5 font-medium text-ink">
                            {match.buyDate} → {match.sellDate}
                          </td>
                          <td className="px-3 py-3.5 text-ink-2">
                            {match.portfolioName}
                            {match.closedViaPortfolioName && (
                              <div className="text-[11.5px] text-ink-3">
                                Closed by Sell All in{" "}
                                {match.closedViaPortfolioName}
                              </div>
                            )}
                          </td>
                          <td className="num whitespace-nowrap px-3 py-3.5 text-right text-ink">
                            {formatQuantity(match.sharesMatched)}
                          </td>
                          <td className="num whitespace-nowrap px-3 py-3.5 text-right text-ink">
                            {formatMoney(
                              match.allocatedCostBasis,
                              instrument.currency,
                            )}
                          </td>
                          <td className="num whitespace-nowrap px-3 py-3.5 text-right text-ink">
                            {formatMoney(
                              match.netSaleProceeds,
                              instrument.currency,
                            )}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3.5 text-right">
                            <div>
                              <GainBadge
                                amount={match.realizedPnl}
                                currency={instrument.currency}
                                percent={match.realizedPnlPercent}
                                size="sm"
                              />
                              {instrument.currency !== baseCurrency &&
                                match.realizedPnlInBase && (
                                  <div className="num mt-0.5 text-[11.5px] text-ink-3">
                                    {formatMoney(
                                      match.realizedPnlInBase,
                                      baseCurrency,
                                      { signed: true },
                                    )}
                                  </div>
                                )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Card>
        )}

        {/* TAB 3: TRANSACTIONS HISTORY */}
        {ledgerTab === "transactions" && (
          <Card className="overflow-hidden">
            {filteredTransactions.length === 0 ? (
              <div className="px-4 py-10 text-center text-[14px] text-ink-3">
                No transactions recorded for {instrument.symbol} in this scope.
              </div>
            ) : (
              <div className="divide-y divide-line">
                {filteredTransactions.map((tx) => {
                  const isConfirming = confirmDeleteTxId === tx.id;
                  const isDeleting = deletingTxId === tx.id;

                  return (
                    <div
                      key={tx.id}
                      className="flex flex-col gap-2.5 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${
                              tx.type === "Buy"
                                ? "bg-accent/12 text-accent"
                                : tx.type === "Dividend"
                                  ? "bg-gain/12 text-gain"
                                  : "bg-loss/12 text-loss"
                            }`}
                          >
                            {tx.type}
                          </span>
                          <span className="num text-[13.5px] font-medium text-ink">
                            {tx.localDate}
                          </span>
                          <span className="text-[12.5px] text-ink-3">
                            · {tx.portfolioName}
                          </span>
                        </div>

                        <p className="num mt-1 text-[13px] text-ink-2">
                          {tx.type === "Dividend"
                            ? `Cash dividend ${formatMoney(tx.quantity, tx.currency)}`
                            : tx.type === "Sell All"
                              ? `All open shares @ ${formatMoney(tx.price, tx.currency, { maximumFractionDigits: 4 })}`
                              : `${formatQuantity(tx.quantity)} sh @ ${formatMoney(tx.price, tx.currency, { maximumFractionDigits: 4 })}`}
                          {tx.totalCostSgd
                            ? ` · ${formatMoney(tx.totalCostSgd, "SGD")} total`
                            : ""}
                        </p>

                        {tx.type === "Sell All" && (
                          <p className="mt-0.5 text-[12px] text-ink-3">
                            Closes {instrument.symbol} in every portfolio that
                            holds it.
                          </p>
                        )}

                        {tx.notes && (
                          <p className="mt-0.5 text-[12px] text-ink-3">
                            {tx.notes}
                          </p>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 self-end sm:self-center">
                        {isConfirming ? (
                          <>
                            <Button
                              variant="danger"
                              onClick={() => void handleDeleteTransaction(tx.id)}
                              disabled={isDeleting}
                              className="h-8 px-3 text-[12.5px]"
                            >
                              {isDeleting ? "Deleting…" : "Confirm delete"}
                            </Button>
                            <Button
                              variant="secondary"
                              onClick={() => setConfirmDeleteTxId(null)}
                              disabled={isDeleting}
                              className="h-8 px-2.5 text-[12.5px]"
                            >
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => openEditTradeSheet(tx)}
                              aria-label={`Edit ${tx.type} transaction on ${tx.localDate}`}
                              className="flex h-8 w-8 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
                            >
                              <Pencil size={14} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteTxId(tx.id)}
                              aria-label={`Delete ${tx.type} transaction on ${tx.localDate}`}
                              className="flex h-8 w-8 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-loss/12 hover:text-loss"
                            >
                              <Trash2 size={14} aria-hidden="true" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        )}
      </div>

      {/* Manual Price / Delisted-Worthless Override Sheet */}
      <Sheet
        isOpen={isOverrideOpen}
        onClose={() => setIsOverrideOpen(false)}
        title={`Price override · ${instrument.symbol}`}
        description="Override live market quotes for unlisted, suspended, crypto, or delisted positions."
      >
        <form onSubmit={handleOverrideSubmit} className="space-y-4">
          <label className="flex cursor-pointer items-start gap-3 rounded-[13px] border border-line bg-field-bg p-3.5">
            <input
              type="checkbox"
              checked={isDelistedInput}
              onChange={(e) => setIsDelistedInput(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded accent-accent"
            />
            <div className="text-[13.5px]">
              <span className="font-medium text-ink">
                Mark as delisted or worthless
              </span>
              <p className="mt-0.5 text-[12.5px] leading-snug text-ink-2">
                Values the position at {formatMoney(0, instrument.currency)}{" "}
                unless a custom liquidation/recovery price is entered below.
              </p>
            </div>
          </label>

          <div>
            <label
              htmlFor="override-manual-price"
              className="mb-1.5 block text-[13px] font-medium text-ink-2"
            >
              Manual unit price ({instrument.currency})
            </label>
            <input
              id="override-manual-price"
              type="text"
              inputMode="decimal"
              value={manualPriceInput}
              onChange={(e) => setManualPriceInput(e.target.value)}
              placeholder="Leave blank to use live quote (or 0 if worthless)"
              className="field-input num"
            />
          </div>

          {overrideError && (
            <p className="rounded-[11px] bg-loss/10 px-3 py-2 text-[13px] text-loss">
              {overrideError}
            </p>
          )}

          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-between">
            {hasActiveOverride ? (
              <Button
                type="button"
                variant="secondary"
                disabled={isSavingOverride}
                onClick={() =>
                  void saveOverride({ manualPrice: null, isDelisted: false })
                }
              >
                Reset to live quote
              </Button>
            ) : (
              <span />
            )}

            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setIsOverrideOpen(false)}
                disabled={isSavingOverride}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSavingOverride}>
                {isSavingOverride ? "Saving…" : "Save override"}
              </Button>
            </div>
          </div>
        </form>
      </Sheet>

      {/* Inline Create / Edit Transaction Sheet */}
      <TransactionSheet
        key={
          isTxSheetOpen
            ? `detail-tx-${editingTx?.id ?? "new"}`
            : "detail-tx-closed"
        }
        isOpen={isTxSheetOpen}
        onClose={() => {
          setIsTxSheetOpen(false);
          setEditingTx(null);
        }}
        onSaved={() => router.refresh()}
        portfolios={portfolios}
        positions={sheetPositions}
        editingTransaction={editingTx}
        defaultPortfolioId={
          selectedPortfolioId !== "all"
            ? selectedPortfolioId
            : symbolPortfolios[0]?.id
        }
        defaultStock={
          editingTx
            ? null
            : {
                symbol: instrument.symbol,
                name: instrument.name ?? fundamentals.name,
                exchangeCode:
                  instrument.exchangeCode ?? fundamentals.exchangeName,
                currency: instrument.currency === "SGD" ? "SGD" : "USD",
              }
        }
      />
    </div>
  );
}

