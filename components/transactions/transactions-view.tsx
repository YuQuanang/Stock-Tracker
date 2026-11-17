"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  ArrowLeftRight,
  ChevronDown,
  FolderPlus,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Split,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import type { Portfolio } from "@/db/schema";
import { PortfolioManageSheet } from "@/components/portfolios/portfolio-manage-sheet";
import { CorporateActionsSheet } from "@/components/transactions/corporate-actions-sheet";
import { TransactionSheet } from "@/components/transactions/transaction-sheet";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { formatMoney, formatQuantity } from "@/lib/format";
import type {
  EnrichedCorporateAction,
  EnrichedTransactionRow,
  LedgerPositionSummary,
} from "@/lib/services/ledger";
import { formatExchangeCodeForDisplay } from "@/lib/transactions/form-logic";

type TypeFilter = "All" | "Buy" | "Sell" | "Sell All" | "Dividend";

const TYPE_FILTER_OPTIONS: { value: TypeFilter; label: string }[] = [
  { value: "All", label: "All" },
  { value: "Buy", label: "Buys" },
  { value: "Sell", label: "Sells" },
  { value: "Sell All", label: "Sell All" },
  { value: "Dividend", label: "Dividends" },
];

interface TransactionsViewProps {
  portfolios: Portfolio[];
  transactions: EnrichedTransactionRow[];
  positions: LedgerPositionSummary[];
  zeroCostBuys: {
    transactionId: string;
    portfolioName: string;
    symbol: string;
    localDate: string;
    shares: string;
  }[];
  corporateActions: EnrichedCorporateAction[];
}

export function TransactionsView({
  portfolios,
  transactions,
  positions,
  zeroCostBuys,
  corporateActions,
}: TransactionsViewProps) {
  const router = useRouter();
  const holdingsPortfolios = portfolios.filter((p) => p.type === "holdings");

  const [selectedPortfolioId, setSelectedPortfolioId] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("All");
  const [searchQuery, setSearchQuery] = useState("");

  const [isTxSheetOpen, setIsTxSheetOpen] = useState(false);
  const [editingTx, setEditingTx] = useState<EnrichedTransactionRow | null>(
    null,
  );
  const [isPortfolioSheetOpen, setIsPortfolioSheetOpen] = useState(false);
  const [isSplitsSheetOpen, setIsSplitsSheetOpen] = useState(false);

  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isRecalculatingSgd, setIsRecalculatingSgd] = useState(false);
  const [recalcSgdMessage, setRecalcSgdMessage] = useState<string | null>(null);

  const missingSgdCount = useMemo(
    () => transactions.filter((tx) => tx.totalCostSgd === null).length,
    [transactions],
  );

  const filteredTransactions = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    return transactions.filter((tx) => {
      if (
        selectedPortfolioId !== "all" &&
        tx.portfolioId !== selectedPortfolioId
      ) {
        return false;
      }
      if (typeFilter !== "All" && tx.type !== typeFilter) {
        return false;
      }
      if (needle !== "") {
        const haystack =
          `${tx.symbol} ${tx.instrumentName ?? ""} ${tx.portfolioName} ${tx.notes ?? ""}`.toLowerCase();
        if (!haystack.includes(needle)) {
          return false;
        }
      }
      return true;
    });
  }, [transactions, selectedPortfolioId, typeFilter, searchQuery]);

  const filteredPositions = useMemo(() => {
    if (selectedPortfolioId === "all") {
      return positions;
    }
    return positions.filter((pos) => pos.portfolioId === selectedPortfolioId);
  }, [positions, selectedPortfolioId]);

  const openCount = filteredPositions.filter(
    (pos) => Number(pos.sharesHeld) > 0,
  ).length;
  const closedCount = filteredPositions.filter(
    (pos) => Number(pos.sharesHeld) === 0 && pos.closedTradeCount > 0,
  ).length;

  async function handleDeleteTransaction(
    row: EnrichedTransactionRow,
  ): Promise<void> {
    setDeleteError(null);
    const confirmed = window.confirm(
      `Delete ${row.type} of ${row.symbol} on ${row.localDate}?`,
    );
    if (!confirmed) {
      return;
    }

    const response = await fetch(`/api/transactions/${row.id}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      setDeleteError(body?.error ?? "Could not delete transaction.");
      return;
    }

    router.refresh();
  }

  function openNewTransaction(): void {
    if (holdingsPortfolios.length === 0) {
      setIsPortfolioSheetOpen(true);
      return;
    }
    setEditingTx(null);
    setIsTxSheetOpen(true);
  }

  function openEditTransaction(row: EnrichedTransactionRow): void {
    setEditingTx(row);
    setIsTxSheetOpen(true);
  }

  async function handleRecalculateSgdTotals(): Promise<void> {
    setIsRecalculatingSgd(true);
    setRecalcSgdMessage(null);
    try {
      const response = await fetch("/api/transactions/recalculate-sgd", {
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as {
        updatedCount?: number;
        fetchFailed?: boolean;
        error?: string;
      } | null;

      if (!response.ok) {
        setRecalcSgdMessage(
          body?.error ?? "Could not fetch historical USD → SGD exchange rates.",
        );
        return;
      }

      if (body?.fetchFailed) {
        setRecalcSgdMessage(
          "Could not reach historical FX providers right now. Check your connection and try again.",
        );
      }
      router.refresh();
    } catch {
      setRecalcSgdMessage(
        "Network error while fetching historical USD → SGD exchange rates.",
      );
    } finally {
      setIsRecalculatingSgd(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Responsive Apple Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1 sm:flex-none">
            <select
              aria-label="Filter by portfolio"
              value={selectedPortfolioId}
              onChange={(event) => setSelectedPortfolioId(event.target.value)}
              className="field-input h-10 appearance-none bg-surface pr-9 text-[14px] font-medium"
            >
              <option value="all">
                All portfolios ({holdingsPortfolios.length})
              </option>
              {holdingsPortfolios.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <ChevronDown
              size={16}
              strokeWidth={2}
              aria-hidden="true"
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-2"
            />
          </div>

          <Button
            variant="secondary"
            onClick={() => setIsPortfolioSheetOpen(true)}
            className="h-10 px-3.5 text-[14px]"
          >
            <FolderPlus size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>
              {selectedPortfolioId !== "all" ? "Rename Portfolio" : "Portfolios"}
            </span>
          </Button>

          <Button
            variant="ghost"
            onClick={() => setIsSplitsSheetOpen(true)}
            className="h-10 px-3 text-[14px]"
          >
            <Split size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>Splits ({corporateActions.length})</span>
          </Button>
        </div>

        <Button
          onClick={openNewTransaction}
          className="h-10 w-full px-4 text-[14px] sm:w-auto"
        >
          <Plus size={16} strokeWidth={2} aria-hidden="true" />
          <span>New Transaction</span>
        </Button>
      </div>

      {/* Summary metrics strip when transactions exist */}
      {transactions.length > 0 && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Card className="p-4">
            <p className="text-[12px] font-medium text-ink-2">Transactions</p>
            <p className="num mt-1 text-[22px] font-semibold tracking-tight">
              {filteredTransactions.length}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-[12px] font-medium text-ink-2">Open positions</p>
            <p className="num mt-1 text-[22px] font-semibold tracking-tight">
              {openCount}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-[12px] font-medium text-ink-2">
              Closed positions
            </p>
            <p className="num mt-1 text-[22px] font-semibold tracking-tight">
              {closedCount}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-[12px] font-medium text-ink-2">Zero-cost buys</p>
            <p className="num mt-1 text-[22px] font-semibold tracking-tight">
              {zeroCostBuys.length}
            </p>
          </Card>
        </div>
      )}

      {/* Data-quality callout for zero-cost buys (section 5.2) */}
      {zeroCostBuys.length > 0 && (
        <Card className="flex items-start gap-3 px-4 py-3.5 sm:px-5 sm:py-4">
          <TriangleAlert
            size={18}
            className="mt-0.5 shrink-0 text-accent"
            aria-hidden="true"
          />
          <div className="text-[13.5px] leading-relaxed">
            <p className="font-medium text-ink">
              Data quality: {zeroCostBuys.length} zero-cost buy
              {zeroCostBuys.length === 1 ? "" : "s"} recorded
            </p>
            <p className="mt-0.5 text-ink-2">
              {zeroCostBuys
                .map(
                  (flag) =>
                    `${flag.symbol} (${flag.portfolioName}, ${flag.shares} shares on ${flag.localDate})`,
                )
                .join(" · ")}
              . Tap Edit on a row if you want to assign a transfer cost basis.
            </p>
          </div>
        </Card>
      )}

      {missingSgdCount > 0 && (
        <Card className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5 sm:py-4">
          <div className="flex items-start gap-3">
            <TriangleAlert
              size={18}
              className="mt-0.5 shrink-0 text-accent"
              aria-hidden="true"
            />
            <div className="text-[13.5px] leading-relaxed">
              <p className="font-medium text-ink">
                {missingSgdCount} transaction
                {missingSgdCount === 1 ? " is" : "s are"} missing historical SGD
                totals
              </p>
              <p className="mt-0.5 text-ink-2">
                {recalcSgdMessage ??
                  "Historical USD → SGD exchange rates on the transaction dates were unavailable when imported."}
              </p>
            </div>
          </div>

          <Button
            variant="secondary"
            onClick={handleRecalculateSgdTotals}
            disabled={isRecalculatingSgd}
            className="h-9.5 shrink-0 px-3.5 text-[13.5px]"
          >
            <RefreshCw
              size={15}
              strokeWidth={1.9}
              aria-hidden="true"
              className={isRecalculatingSgd ? "animate-spin" : undefined}
            />
            <span>
              {isRecalculatingSgd
                ? "Calculating SGD…"
                : "Calculate SGD Totals"}
            </span>
          </Button>
        </Card>
      )}

      {deleteError && (
        <div
          role="alert"
          className="rounded-[12px] border border-loss/30 bg-loss/10 px-4 py-3 text-[14px] text-loss"
        >
          {deleteError}
        </div>
      )}

      {transactions.length === 0 ? (
        <EmptyState
          icon={ArrowLeftRight}
          title="Your ledger is empty"
          description={
            holdingsPortfolios.length === 0
              ? "Create your first holdings portfolio (for example, US Stocks or SG Stocks) to record a trade, or import your CSV export."
              : "Record your first Buy transaction, or import your Microsoft Start CSV export."
          }
          actions={
            <>
              <Button onClick={openNewTransaction}>
                <Plus size={18} strokeWidth={2} aria-hidden="true" />
                {holdingsPortfolios.length === 0
                  ? "Create Portfolio"
                  : "New Transaction"}
              </Button>
              <ButtonLink href="/import-export" variant="secondary">
                Import CSV
              </ButtonLink>
            </>
          }
        />
      ) : (
        <>
          {/* Filter controls */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <SegmentedControl
              ariaLabel="Filter by transaction type"
              options={TYPE_FILTER_OPTIONS}
              value={typeFilter}
              onChange={setTypeFilter}
              layoutId="tx-filter-type"
            />

            <div className="relative w-full sm:max-w-[260px]">
              <Search
                size={16}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-2"
                aria-hidden="true"
              />
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search symbol or note…"
                aria-label="Filter transactions"
                className="field-input h-9.5 bg-surface pl-9.5 pr-3 text-[14px]"
              />
            </div>
          </div>

          {/* Mobile Apple Inset List (< 768px) */}
          <Card className="divide-y divide-line overflow-hidden md:hidden">
            {filteredTransactions.length === 0 ? (
              <div className="px-4 py-10 text-center text-[14px] text-ink-2">
                No transactions match the current filters.
              </div>
            ) : (
              filteredTransactions.map((row) => {
                const exchangeLabel = formatExchangeCodeForDisplay(
                  row.exchangeCode,
                );
                const qtyAndPriceText =
                  row.type === "Sell All"
                    ? `All shares @ ${formatMoney(row.price, row.currency)}`
                    : row.type === "Dividend"
                      ? (() => {
                          const gross = Number(row.quantity);
                          const commVal = Number(row.commissionValue ?? 0);
                          const taxAmt = row.commissionIsPercent
                            ? (gross * commVal) / 100
                            : commVal;
                          const net = Math.max(0, gross - taxAmt);
                          return taxAmt > 0
                            ? `Net ${formatMoney(net, row.currency)} (Gross ${formatMoney(gross, row.currency)} · ${row.commissionRaw} tax)`
                            : `Dividend · ${formatMoney(row.quantity, row.currency)}`;
                        })()
                      : `${formatQuantity(row.quantity)} sh × ${formatMoney(row.price, row.currency)}`;

                return (
                  <div key={row.id} className="px-4 py-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono text-[15px] font-semibold text-ink">
                            {row.symbol}
                          </span>
                          <span className="rounded-[6px] bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-ink-2">
                            {row.type}
                          </span>
                          {exchangeLabel && (
                            <span className="text-[11px] text-ink-3">
                              {exchangeLabel}
                            </span>
                          )}
                        </div>
                        {row.instrumentName && (
                          <p className="mt-0.5 truncate text-[12.5px] text-ink-2">
                            {row.instrumentName}
                          </p>
                        )}
                      </div>

                      <div className="shrink-0 text-right">
                        <p className="num text-[15px] font-semibold text-ink">
                          {row.totalCostSgd
                            ? formatMoney(row.totalCostSgd, "SGD")
                            : "—"}
                        </p>
                        <p className="num mt-0.5 text-[12px] text-ink-2">
                          {qtyAndPriceText}
                          {row.currency === "USD" && row.fxRateToSgd
                            ? ` · @${row.fxRateToSgd}`
                            : ""}
                        </p>
                      </div>
                    </div>

                    <div className="mt-2 flex items-center justify-between gap-2 text-[12px] text-ink-2">
                      <span className="truncate">
                        {row.portfolioName} ·{" "}
                        <span className="font-mono">
                          {row.localDate} {row.localTime.slice(0, 5)}
                        </span>
                      </span>
                      <div className="inline-flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => openEditTransaction(row)}
                          aria-label={`Edit ${row.symbol} transaction`}
                          className="rounded-[8px] p-1.5 text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
                        >
                          <Pencil size={16} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteTransaction(row)}
                          aria-label={`Delete ${row.symbol} transaction`}
                          className="rounded-[8px] p-1.5 text-ink-2 transition-colors hover:bg-surface-2 hover:text-loss"
                        >
                          <Trash2 size={16} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </Card>

          {/* Desktop Financial Ledger Table (>= 768px) */}
          <Card className="hidden overflow-hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-[14px]">
                <thead>
                  <tr className="border-b border-line text-[12px] font-medium text-ink-2">
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Portfolio</th>
                    <th className="px-4 py-3">Symbol</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3 text-right">Shares / Cash</th>
                    <th className="px-4 py-3 text-right">Price</th>
                    <th className="px-4 py-3 text-right">Total (SGD)</th>
                    <th className="px-4 py-3 text-right">Commission</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {filteredTransactions.length === 0 ? (
                    <tr>
                      <td
                        colSpan={9}
                        className="px-4 py-10 text-center text-ink-2"
                      >
                        No transactions match the current filters.
                      </td>
                    </tr>
                  ) : (
                    filteredTransactions.map((row) => {
                      const exchangeLabel = formatExchangeCodeForDisplay(
                        row.exchangeCode,
                      );
                      return (
                        <tr
                          key={row.id}
                          className="transition-colors hover:bg-surface-2"
                        >
                          <td className="font-mono whitespace-nowrap px-4 py-3 text-[13px]">
                            <div>{row.localDate}</div>
                            <div className="text-[12px] text-ink-3">
                              {row.localTime}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-ink-2">
                            {row.portfolioName}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono font-semibold">
                                {row.symbol}
                              </span>
                              {exchangeLabel && (
                                <span className="rounded-[6px] bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-ink-2">
                                  {exchangeLabel}
                                </span>
                              )}
                            </div>
                            {row.instrumentName && (
                              <div className="max-w-[200px] truncate text-[12px] text-ink-2">
                                {row.instrumentName}
                              </div>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3">
                            <span className="inline-flex rounded-[6px] bg-surface-2 px-2.5 py-0.5 text-[12px] font-medium">
                              {row.type}
                            </span>
                          </td>
                          <td className="num whitespace-nowrap px-4 py-3 text-right">
                            {row.type === "Sell All" ? (
                              "All shares"
                            ) : row.type === "Dividend" ? (
                              (() => {
                                const gross = Number(row.quantity);
                                const commVal = Number(row.commissionValue ?? 0);
                                const taxAmt = row.commissionIsPercent
                                  ? (gross * commVal) / 100
                                  : commVal;
                                const net = Math.max(0, gross - taxAmt);
                                return (
                                  <div>
                                    <div className="font-medium text-gain">
                                      {formatMoney(net, row.currency)}
                                    </div>
                                    {taxAmt > 0 && (
                                      <div className="text-[11px] text-ink-2">
                                        Gross {formatMoney(gross, row.currency)}
                                      </div>
                                    )}
                                  </div>
                                );
                              })()
                            ) : (
                              formatQuantity(row.quantity)
                            )}
                          </td>
                          <td className="num whitespace-nowrap px-4 py-3 text-right">
                            <div>
                              {formatMoney(row.price, row.currency)}
                            </div>
                            {row.isManualPrice && (
                              <div className="text-[11px] text-accent">
                                Manual price
                              </div>
                            )}
                          </td>
                          <td className="num whitespace-nowrap px-4 py-3 text-right">
                            <div>
                              {row.totalCostSgd
                                ? formatMoney(row.totalCostSgd, "SGD")
                                : "—"}
                            </div>
                            {row.currency === "USD" && row.fxRateToSgd && (
                              <div className="text-[11px] text-ink-2">
                                @{row.fxRateToSgd}
                                {row.isManualFxRate ? " (manual)" : ""}
                              </div>
                            )}
                          </td>
                          <td className="num whitespace-nowrap px-4 py-3 text-right text-ink-2">
                            {row.commissionRaw && row.commissionRaw !== "0"
                              ? row.commissionIsPercent
                                ? row.commissionRaw
                                : formatMoney(row.commissionRaw, row.currency)
                              : "—"}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right">
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => openEditTransaction(row)}
                                aria-label={`Edit ${row.symbol} transaction`}
                                className="rounded-[8px] p-1.5 text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
                              >
                                <Pencil size={16} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteTransaction(row)}
                                aria-label={`Delete ${row.symbol} transaction`}
                                className="rounded-[8px] p-1.5 text-ink-2 transition-colors hover:bg-surface-2 hover:text-loss"
                              >
                                <Trash2 size={16} aria-hidden="true" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {/* Key forces fresh form state whenever editingTx or open status changes */}
      <TransactionSheet
        key={`${editingTx?.id ?? "new"}-${isTxSheetOpen ? "open" : "closed"}`}
        isOpen={isTxSheetOpen}
        onClose={() => setIsTxSheetOpen(false)}
        onSaved={() => router.refresh()}
        portfolios={portfolios}
        positions={positions}
        editingTransaction={editingTx}
        defaultPortfolioId={
          selectedPortfolioId !== "all" ? selectedPortfolioId : undefined
        }
      />

      <PortfolioManageSheet
        isOpen={isPortfolioSheetOpen}
        portfolios={holdingsPortfolios}
        initialSelectedPortfolioId={selectedPortfolioId}
        onClose={() => setIsPortfolioSheetOpen(false)}
        onChanged={() => router.refresh()}
        onCreated={(id) => setSelectedPortfolioId(id)}
      />

      <CorporateActionsSheet
        isOpen={isSplitsSheetOpen}
        onClose={() => setIsSplitsSheetOpen(false)}
        actions={corporateActions}
        onChanged={() => router.refresh()}
      />
    </div>
  );
}
