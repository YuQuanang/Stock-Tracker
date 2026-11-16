"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  Bell,
  BellRing,
  Calculator,
  ChevronDown,
  ChevronRight,
  Eye,
  FolderCog,
  GripVertical,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import type { Portfolio } from "@/db/schema";
import {
  TickerMigrationSheet,
  type TickerMigrationTarget,
} from "@/components/holdings/ticker-migration-sheet";
import { Sparkline } from "@/components/charts/sparkline";
import {
  TransactionSheet,
  type DefaultTransactionStock,
} from "@/components/transactions/transaction-sheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { GainBadge } from "@/components/ui/gain-badge";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { AddSymbolSheet } from "@/components/watchlist/add-symbol-sheet";
import { SimulateAlertsSheet } from "@/components/watchlist/simulate-alerts-sheet";
import { WatchlistManageSheet } from "@/components/watchlist/watchlist-manage-sheet";
import { usePriceFlashRef } from "@/hooks/use-price-flash";
import { useQuotesPoll } from "@/hooks/use-quotes-poll";
import {
  formatCompactFreshness,
  formatMoney,
  formatPercent,
  formatQuantity,
} from "@/lib/format";
import type { ResolvedInstrumentQuote } from "@/lib/market-data/batch-quotes";
import type { ExchangeRateSnapshot } from "@/lib/market-data/fx";
import type { CombinedMarketOverview } from "@/lib/market-data/hours";
import { getSgxTickerTransition } from "@/lib/market-data/sgx-transitions";
import type { LedgerPositionSummary } from "@/lib/services/ledger";
import {
  formatExchangeCodeForDisplay,
  formatSymbolForDisplay,
} from "@/lib/transactions/form-logic";
import {
  computeWatchlistItemValuation,
  type SerializedWatchlistItem,
  type ValuedWatchlistItem,
} from "@/lib/watchlist/valuation";

type SortMode = "custom" | "dayChange" | "paperReturn" | "symbol";

interface ConvertToBuyTarget {
  key: string;
  stock: DefaultTransactionStock;
  quantity?: string;
}

interface WatchlistViewProps {
  portfolios: Portfolio[];
  positions: LedgerPositionSummary[];
  items: SerializedWatchlistItem[];
  initialQuotes: Record<string, ResolvedInstrumentQuote>;
  initialFxUsdToSgd: ExchangeRateSnapshot | null;
  initialMarket: CombinedMarketOverview;
  baseCurrency: "SGD" | "USD";
  defaultBenchmark: string;
}

function parseSortableNumber(val: string | null): number | null {
  if (val === null) {
    return null;
  }
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function compareNullableDesc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

function FlashPrice({
  value,
  children,
  className = "",
}: {
  value: number | null;
  children: React.ReactNode;
  className?: string;
}) {
  const ref = usePriceFlashRef<HTMLDivElement>(value);
  return (
    <div ref={ref} className={`rounded-[6px] ${className}`}>
      {children}
    </div>
  );
}

function Range52WBar({ item }: { item: ValuedWatchlistItem }) {
  if (
    item.fiftyTwoWeekLow === null ||
    item.fiftyTwoWeekHigh === null ||
    item.range52wPercent === null
  ) {
    return <span className="text-[12px] text-ink-3">—</span>;
  }

  return (
    <div className="min-w-[120px] max-w-[156px] space-y-1.5">
      <div className="relative h-1.5 w-full rounded-full bg-line">
        <div
          className="h-full rounded-full bg-accent/35"
          style={{ width: `${item.range52wPercent}%` }}
        />
        <span
          aria-hidden="true"
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-accent"
          style={{ left: `${item.range52wPercent}%` }}
        />
      </div>
      <div className="num flex items-center justify-between gap-2 text-[11px] font-medium text-ink-2">
        <span>{formatMoney(item.fiftyTwoWeekLow, item.currency)}</span>
        <span>{formatMoney(item.fiftyTwoWeekHigh, item.currency)}</span>
      </div>
    </div>
  );
}

function AlertPriceBadge({
  item,
  onOpenModal,
  emptyFallback = "dash",
}: {
  item: ValuedWatchlistItem;
  onOpenModal: () => void;
  emptyFallback?: "dash" | "none";
}) {
  const isTriggered =
    item.alertState === "triggered-above" ||
    item.alertState === "triggered-below";
  const displaySymbol = formatSymbolForDisplay(item.symbol);

  if (item.alertState === "none") {
    if (emptyFallback === "none") {
      return null;
    }
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpenModal();
        }}
        title={`Set alert price for ${displaySymbol}`}
        aria-label={`Set alert price for ${displaySymbol}`}
        className="num inline-flex cursor-pointer items-center rounded-[6px] px-1.5 py-0.5 text-[13px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-accent"
      >
        —
      </button>
    );
  }

  const label =
    item.alertState === "triggered-above"
      ? `Hit ≥ ${formatMoney(item.alertAbove ?? "0", item.currency)}`
      : item.alertState === "triggered-below"
        ? `Hit ≤ ${formatMoney(item.alertBelow ?? "0", item.currency)}`
        : [
            item.alertAbove
              ? `≥ ${formatMoney(item.alertAbove, item.currency)}`
              : null,
            item.alertBelow
              ? `≤ ${formatMoney(item.alertBelow, item.currency)}`
              : null,
          ]
            .filter(Boolean)
            .join(" / ");

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpenModal();
      }}
      className={`num inline-flex cursor-pointer items-center gap-1 rounded-[6px] px-2 py-0.5 text-[11.5px] font-medium transition-opacity hover:opacity-85 ${
        isTriggered
          ? "bg-accent/15 text-accent"
          : "bg-surface-2 text-ink-2"
      }`}
    >
      {isTriggered ? (
        <BellRing className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <Bell className="h-3.5 w-3.5 shrink-0 text-ink-2" aria-hidden="true" />
      )}
      <span>{label}</span>
    </button>
  );
}

function PaperSimBadge({
  item,
  onOpenModal,
}: {
  item: ValuedWatchlistItem;
  onOpenModal: () => void;
}) {
  const hasPaper = Boolean(
    item.paperEntryDate && item.paperAmount && item.paperShares,
  );
  if (!hasPaper) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpenModal();
      }}
      className="inline-flex cursor-pointer items-center gap-1 text-left text-[12px] leading-snug transition-opacity hover:opacity-80"
    >
      <span className="num text-ink-2">
        Sim {formatQuantity(item.paperShares ?? "0")} sh ·
      </span>
      {item.paperGainPercent !== null ? (
        <span
          className={`num font-semibold ${
            Number(item.paperGainPercent) >= 0 ? "text-gain" : "text-loss"
          }`}
        >
          {formatPercent(item.paperGainPercent)}
        </span>
      ) : (
        <span className="text-ink-2">Unavailable</span>
      )}
      {item.paperExcessReturnPercent !== null && item.paperBenchmark && (
        <span className="num text-ink-2">
          ({Number(item.paperExcessReturnPercent) >= 0 ? "+" : ""}
          {formatPercent(item.paperExcessReturnPercent, { signed: false })} vs{" "}
          {item.paperBenchmark.benchmarkName})
        </span>
      )}
    </button>
  );
}

export function WatchlistView({
  portfolios,
  positions,
  items,
  initialQuotes,
  initialFxUsdToSgd,
  initialMarket,
  baseCurrency,
  defaultBenchmark,
}: WatchlistViewProps) {
  const router = useRouter();

  const watchlistPortfolios = useMemo(
    () => portfolios.filter((p) => p.type === "watchlist"),
    [portfolios],
  );
  const holdingsPortfolios = useMemo(
    () => portfolios.filter((p) => p.type === "holdings"),
    [portfolios],
  );

  const [selectedWatchlistId, setSelectedWatchlistId] = useState<string>(
    () => watchlistPortfolios[0]?.id ?? "",
  );
  const activeWatchlist =
    watchlistPortfolios.find((w) => w.id === selectedWatchlistId) ??
    watchlistPortfolios[0] ??
    null;
  const activeWatchlistId = activeWatchlist?.id ?? "";

  const [searchQuery, setSearchQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("custom");
  const [optimisticOrderByList, setOptimisticOrderByList] = useState<
    Record<string, string[]>
  >({});
  const [draggedInstrumentId, setDraggedInstrumentId] = useState<string | null>(
    null,
  );
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [isAddSheetOpen, setIsAddSheetOpen] = useState(false);
  const [isManageSheetOpen, setIsManageSheetOpen] = useState(false);
  const [simulatingItem, setSimulatingItem] =
    useState<ValuedWatchlistItem | null>(null);
  const [convertTarget, setConvertTarget] =
    useState<ConvertToBuyTarget | null>(null);

  const [retryingSymbol, setRetryingSymbol] = useState<string | null>(null);
  const [retryFeedback, setRetryFeedback] = useState<string | null>(null);
  const [migrationTarget, setMigrationTarget] =
    useState<TickerMigrationTarget | null>(null);

  const trackedSymbols = useMemo(
    () => [
      ...new Set(
        items
          .filter(
            (item) =>
              item.assetType !== "crypto" &&
              !item.priceNotFound &&
              !initialQuotes[item.symbol]?.priceNotFound,
          )
          .map((item) => item.symbol),
      ),
    ],
    [items, initialQuotes],
  );

  const {
    quotes,
    fxUsdToSgd,
    isRefreshing,
    isRetrying,
    refreshNow,
    retrySymbols,
  } = useQuotesPoll({
    symbols: trackedSymbols,
    includeSparklines: true,
    enabled: trackedSymbols.length > 0,
    initialQuotes,
    initialFxUsdToSgd,
    initialMarket,
  });

  const itemCountByPortfolio = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      counts.set(item.portfolioId, (counts.get(item.portfolioId) ?? 0) + 1);
    }
    return counts;
  }, [items]);

  const activeItemsOrdered = useMemo(() => {
    if (!activeWatchlistId) {
      return [];
    }
    const listItems = items.filter((i) => i.portfolioId === activeWatchlistId);
    const customIds = optimisticOrderByList[activeWatchlistId];
    if (!customIds || customIds.length === 0) {
      return listItems;
    }

    const byId = new Map(listItems.map((item) => [item.instrumentId, item]));
    const ordered: SerializedWatchlistItem[] = [];
    for (const id of customIds) {
      const found = byId.get(id);
      if (found) {
        ordered.push(found);
        byId.delete(id);
      }
    }
    for (const remaining of byId.values()) {
      ordered.push(remaining);
    }
    return ordered;
  }, [items, activeWatchlistId, optimisticOrderByList]);

  const valuedActiveItems = useMemo(() => {
    const fxRate = fxUsdToSgd?.rate ?? null;
    return activeItemsOrdered.map((item) =>
      computeWatchlistItemValuation(
        item,
        quotes[item.symbol] ?? initialQuotes[item.symbol],
        fxRate,
        baseCurrency,
      ),
    );
  }, [activeItemsOrdered, quotes, initialQuotes, fxUsdToSgd?.rate, baseCurrency]);

  const triggeredAlerts = useMemo(
    () =>
      valuedActiveItems.filter(
        (i) =>
          i.alertState === "triggered-above" ||
          i.alertState === "triggered-below",
      ),
    [valuedActiveItems],
  );

  const displayedItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = q
      ? valuedActiveItems.filter(
          (i) =>
            i.symbol.toLowerCase().includes(q) ||
            formatSymbolForDisplay(i.symbol).toLowerCase().includes(q) ||
            (i.name ?? "").toLowerCase().includes(q),
        )
      : valuedActiveItems;

    if (sortMode === "custom") {
      return filtered;
    }

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      switch (sortMode) {
        case "dayChange":
          return compareNullableDesc(
            parseSortableNumber(a.dayChangePercent),
            parseSortableNumber(b.dayChangePercent),
          );
        case "paperReturn":
          return compareNullableDesc(
            parseSortableNumber(a.paperGainPercent),
            parseSortableNumber(b.paperGainPercent),
          );
        case "symbol":
          return formatSymbolForDisplay(a.symbol).localeCompare(
            formatSymbolForDisplay(b.symbol),
          );
        default:
          return 0;
      }
    });
    return sorted;
  }, [valuedActiveItems, searchQuery, sortMode]);

  const { pricedDisplayedItems, unpricedDisplayedItems } = useMemo(
    () => ({
      pricedDisplayedItems: displayedItems.filter(
        (item) => item.unitPrice !== null,
      ),
      unpricedDisplayedItems: displayedItems.filter(
        (item) => item.unitPrice === null,
      ),
    }),
    [displayedItems],
  );

  const retryableNotFoundSymbols = useMemo(
    () =>
      unpricedDisplayedItems
        .filter((item) => item.assetType !== "crypto")
        .map((item) => item.symbol),
    [unpricedDisplayedItems],
  );

  const hideEmptyPricedWatchlist =
    pricedDisplayedItems.length === 0 && unpricedDisplayedItems.length > 0;

  async function handleRetryLookup(targetSymbols: string[]): Promise<void> {
    if (targetSymbols.length === 0) {
      return;
    }
    setRetryFeedback(null);
    setRetryingSymbol(
      targetSymbols.length === 1 ? targetSymbols[0] : "__all__",
    );
    try {
      const updated = await retrySymbols(targetSymbols);
      const recovered = targetSymbols.filter((sym) => {
        const p = updated?.[sym]?.price;
        return p !== null && p !== undefined;
      });
      if (recovered.length > 0) {
        setRetryFeedback(
          `Found live quote for ${recovered.map(formatSymbolForDisplay).join(", ")}.`,
        );
        router.refresh();
      } else {
        setRetryFeedback(
          `No live quote found for ${targetSymbols.map(formatSymbolForDisplay).join(", ")}.`,
        );
      }
    } finally {
      setRetryingSymbol(null);
    }
  }

  const canReorder =
    sortMode === "custom" &&
    searchQuery.trim() === "" &&
    pricedDisplayedItems.length > 1;

  async function persistNewOrder(nextOrderedIds: string[]) {
    if (!activeWatchlistId) {
      return;
    }
    setActionError(null);
    setOptimisticOrderByList((prev) => ({
      ...prev,
      [activeWatchlistId]: nextOrderedIds,
    }));

    try {
      const response = await fetch("/api/watchlists/items", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          portfolioId: activeWatchlistId,
          orderedInstrumentIds: nextOrderedIds,
        }),
      });
      if (!response.ok) {
        const data = await response.json();
        setActionError(data.error ?? "Unable to save watchlist order.");
        setOptimisticOrderByList((prev) => {
          const next = { ...prev };
          delete next[activeWatchlistId];
          return next;
        });
        return;
      }
      router.refresh();
    } catch {
      setActionError("Network error while reordering watchlist.");
      setOptimisticOrderByList((prev) => {
        const next = { ...prev };
        delete next[activeWatchlistId];
        return next;
      });
    }
  }

  function moveItemByOffset(instrumentId: string, offset: -1 | 1) {
    const ids = activeItemsOrdered.map((item) => item.instrumentId);
    const index = ids.indexOf(instrumentId);
    const targetIndex = index + offset;
    if (index < 0 || targetIndex < 0 || targetIndex >= ids.length) {
      return;
    }
    const nextIds = [...ids];
    const [moved] = nextIds.splice(index, 1);
    nextIds.splice(targetIndex, 0, moved);
    void persistNewOrder(nextIds);
  }

  function handleDropOnItem(targetInstrumentId: string) {
    if (!draggedInstrumentId || draggedInstrumentId === targetInstrumentId) {
      setDraggedInstrumentId(null);
      return;
    }
    const ids = activeItemsOrdered.map((item) => item.instrumentId);
    const fromIndex = ids.indexOf(draggedInstrumentId);
    const toIndex = ids.indexOf(targetInstrumentId);
    setDraggedInstrumentId(null);
    if (fromIndex < 0 || toIndex < 0) {
      return;
    }
    const nextIds = [...ids];
    const [moved] = nextIds.splice(fromIndex, 1);
    nextIds.splice(toIndex, 0, moved);
    void persistNewOrder(nextIds);
  }

  async function handleRemoveItem(item: ValuedWatchlistItem) {
    const key = `${item.portfolioId}::${item.instrumentId}`;
    setRemovingKey(key);
    setActionError(null);
    try {
      const response = await fetch(
        `/api/watchlists/items/${item.portfolioId}/${item.instrumentId}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        const data = await response.json();
        setActionError(
          data.error ??
            `Unable to remove ${formatSymbolForDisplay(item.symbol)}.`,
        );
        setRemovingKey(null);
        return;
      }
      setRemovingKey(null);
      router.refresh();
    } catch {
      setActionError(
        `Network error while removing ${formatSymbolForDisplay(item.symbol)}.`,
      );
      setRemovingKey(null);
    }
  }

  function openConvertToBuy(item: ValuedWatchlistItem) {
    setConvertTarget({
      key: `${item.instrumentId}-${Date.now()}`,
      stock: {
        symbol: item.symbol,
        name: item.name,
        exchangeCode: item.exchangeCode,
        currency: item.currency,
      },
      quantity: item.paperShares ?? undefined,
    });
  }

  return (
    <>
      <PageHeader
        title="Watchlist"
        subtitle="Stocks you follow, price alerts, and what-if paper simulations."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {trackedSymbols.length > 0 && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void refreshNow()}
                disabled={isRefreshing}
              >
                <RefreshCw
                  size={16}
                  strokeWidth={1.9}
                  aria-hidden="true"
                  className={isRefreshing ? "animate-spin" : undefined}
                />
                <span>{isRefreshing ? "Refreshing…" : "Refresh"}</span>
              </Button>
            )}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setIsManageSheetOpen(true)}
            >
              <FolderCog size={16} strokeWidth={1.9} aria-hidden="true" />
              <span>Manage Lists</span>
            </Button>
            {activeWatchlist && (
              <Button
                type="button"
                size="sm"
                onClick={() => setIsAddSheetOpen(true)}
              >
                <Plus size={16} strokeWidth={2} aria-hidden="true" />
                <span>Add Symbol</span>
              </Button>
            )}
          </div>
        }
      />

      {watchlistPortfolios.length === 0 ? (
        <EmptyState
          icon={Eye}
          title="No watchlists yet"
          description="Create a watchlist to follow stocks you do not own yet, set target alerts, and simulate what would have happened if you bought them earlier."
          actions={
            <Button
              type="button"
              onClick={() => setIsManageSheetOpen(true)}
              className="h-10 px-4 text-[14px]"
            >
              <Plus size={16} strokeWidth={2} aria-hidden="true" />
              Create watchlist
            </Button>
          }
        />
      ) : (
        <div className="space-y-6">
          {/* Watchlist Switcher Tabs + FX Reference */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {watchlistPortfolios.map((list) => {
                const isSelected = list.id === activeWatchlistId;
                const count = itemCountByPortfolio.get(list.id) ?? 0;
                return (
                  <button
                    key={list.id}
                    type="button"
                    onClick={() => setSelectedWatchlistId(list.id)}
                    className={`inline-flex cursor-pointer items-center gap-2 rounded-[10px] px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
                      isSelected
                        ? "bg-accent text-accent-ink"
                        : "border border-line bg-surface text-ink-2 hover:text-ink"
                    }`}
                  >
                    <span>{list.name}</span>
                    <span
                      className={`num rounded-[6px] px-1.5 py-0.5 text-[11px] font-semibold ${
                        isSelected
                          ? "bg-accent-ink/15 text-accent-ink"
                          : "bg-surface-2 text-ink-2"
                      }`}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {fxUsdToSgd && (
              <span className="num text-[12px] text-ink-2">
                1 USD = {fxUsdToSgd.rate} SGD ·{" "}
                <span className="font-mono text-ink-3">{fxUsdToSgd.label}</span>
              </span>
            )}
          </div>

          {/* Active Triggered Alerts Banner */}
          {triggeredAlerts.length > 0 && (
            <Card className="flex flex-wrap items-start justify-between gap-3 border-accent/35 bg-surface-2 px-4 py-3.5 sm:px-5 sm:py-4">
              <div className="flex items-start gap-3">
                <BellRing
                  size={18}
                  className="mt-0.5 shrink-0 text-accent"
                  aria-hidden="true"
                />
                <div className="text-[13.5px] leading-relaxed">
                  <p className="font-medium text-ink">
                    {triggeredAlerts.length}{" "}
                    {triggeredAlerts.length === 1
                      ? "price alert triggered"
                      : "price alerts triggered"}
                  </p>
                  <p className="mt-0.5 text-ink-2">
                    Tap a symbol to review its alert threshold or convert to a
                    Buy order.
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {triggeredAlerts.map((alertItem) => (
                  <button
                    key={alertItem.instrumentId}
                    type="button"
                    onClick={() => setSimulatingItem(alertItem)}
                    className="num cursor-pointer rounded-[10px] border border-accent/40 bg-surface px-3 py-1 text-[12.5px] font-medium text-ink transition-colors hover:border-accent"
                  >
                    <span className="font-mono font-semibold">
                      {formatSymbolForDisplay(alertItem.symbol)}
                    </span>{" "}
                    @{" "}
                    {formatMoney(
                      alertItem.unitPrice ?? "0",
                      alertItem.currency,
                    )}
                  </button>
                ))}
              </div>
            </Card>
          )}

          {actionError && (
            <div
              role="alert"
              className="rounded-[10px] bg-loss/10 px-4 py-2.5 text-[13px] text-loss"
            >
              {actionError}
            </div>
          )}

          {activeItemsOrdered.length === 0 ? (
            <EmptyState
              icon={Eye}
              title={`“${activeWatchlist?.name}” is empty`}
              description="Search live tickers to track prices, set buy-zone alerts, or test a historical what-if paper entry."
              actions={
                <Button
                  type="button"
                  onClick={() => setIsAddSheetOpen(true)}
                  className="h-10 px-4 text-[14px]"
                >
                  <Plus size={16} strokeWidth={2} aria-hidden="true" />
                  Add first symbol
                </Button>
              }
            />
          ) : (
            <>
              {/* Sort & Search Toolbar */}
              <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="relative sm:w-[235px]">
                  <select
                    aria-label="Sort watchlist"
                    value={sortMode}
                    onChange={(e) => setSortMode(e.target.value as SortMode)}
                    className="field-input h-9.5 appearance-none bg-surface pr-8 text-[13.5px]"
                  >
                    <option value="custom">Sort: Custom order</option>
                    <option value="dayChange">Sort: Day change %</option>
                    <option value="paperReturn">Sort: Paper return %</option>
                    <option value="symbol">Sort: Symbol A–Z</option>
                  </select>
                  <ChevronDown
                    size={16}
                    strokeWidth={1.9}
                    aria-hidden="true"
                    className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-2"
                  />
                </div>

                <div className="relative w-full sm:w-[240px]">
                  <Search
                    size={16}
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-2"
                    aria-hidden="true"
                  />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search ticker or name…"
                    aria-label="Search watchlist"
                    className="field-input h-9.5 bg-surface pl-9.5 pr-3 text-[14px]"
                  />
                </div>
              </div>

              {displayedItems.length === 0 ? (
                <Card className="px-4 py-10 text-center text-[14px] text-ink-2">
                  No watched symbols match &ldquo;{searchQuery}&rdquo;.
                </Card>
              ) : (
                <>
                  {!hideEmptyPricedWatchlist && (
                    <>
                      {/* Mobile Watchlist (< 768px) */}
                      <Card className="divide-y divide-line overflow-hidden md:hidden">
                        {pricedDisplayedItems.map((item, idx) => {
                      const rowKey = `${item.portfolioId}::${item.instrumentId}`;
                      const isRemoving = removingKey === rowKey;
                      const detailHref = `/holdings/${encodeURIComponent(item.symbol)}`;
                      const exchangeLabel = formatExchangeCodeForDisplay(
                        item.exchangeCode,
                      );

                      return (
                        <div key={rowKey} className="px-4 py-3.5">
                          <Link
                            href={detailHref}
                            className="flex items-center justify-between gap-3"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono text-[15px] font-semibold text-ink">
                                  {formatSymbolForDisplay(item.symbol)}
                                </span>
                                {(exchangeLabel || item.currency) && (
                                  <span className="rounded-[6px] bg-surface-2 px-1.5 py-0.5 text-[10.5px] font-medium text-ink-3">
                                    {exchangeLabel || item.currency}
                                  </span>
                                )}
                              </div>
                              <p className="mt-0.5 truncate text-[12.5px] text-ink-2">
                                {item.name ??
                                  formatSymbolForDisplay(item.symbol)}
                              </p>
                            </div>

                            <Sparkline
                              values={item.sparkline}
                              width={68}
                              height={26}
                            />

                            <div className="shrink-0 text-right">
                              {isRefreshing && !item.unitPrice ? (
                                <div className="space-y-1.5">
                                  <Skeleton className="ml-auto h-4 w-16" />
                                  <Skeleton className="ml-auto h-3.5 w-14" />
                                </div>
                              ) : (
                                <>
                                  <FlashPrice
                                    value={
                                      item.unitPrice
                                        ? Number(item.unitPrice)
                                        : null
                                    }
                                  >
                                    <p className="num text-[15px] font-semibold text-ink">
                                      {item.unitPrice
                                        ? formatMoney(
                                            item.unitPrice,
                                            item.currency,
                                          )
                                        : "Unavailable"}
                                    </p>
                                  </FlashPrice>
                                  <div className="mt-0.5 flex justify-end">
                                    {item.dayChange !== null &&
                                    item.dayChangePercent !== null ? (
                                      <GainBadge
                                        amount={item.dayChange}
                                        currency={item.currency}
                                        percent={item.dayChangePercent}
                                        size="sm"
                                        pill
                                      />
                                    ) : (
                                      <span
                                        title={item.freshnessLabel}
                                        className="font-mono text-[11.5px] text-ink-3"
                                      >
                                        {formatCompactFreshness(item.freshnessLabel)}
                                      </span>
                                    )}
                                  </div>
                                </>
                              )}
                            </div>
                          </Link>

                          {/* Meta details row: freshness & alert price */}
                          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-3 text-[12px] text-ink-2">
                            <span
                              title={item.freshnessLabel}
                              className="font-mono text-ink-3"
                            >
                              {formatCompactFreshness(item.freshnessLabel)}
                            </span>
                            <AlertPriceBadge
                              item={item}
                              onOpenModal={() => setSimulatingItem(item)}
                              emptyFallback="none"
                            />
                          </div>

                          {item.fiftyTwoWeekLow &&
                            item.fiftyTwoWeekHigh &&
                            item.range52wPercent !== null && (
                              <div className="mt-2.5">
                                <Range52WBar item={item} />
                              </div>
                            )}

                          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2">
                            <PaperSimBadge
                              item={item}
                              onOpenModal={() => setSimulatingItem(item)}
                            />

                            <div className="ml-auto flex items-center gap-1">
                              {canReorder && (
                                <>
                                  <button
                                    type="button"
                                    aria-label={`Move ${formatSymbolForDisplay(item.symbol)} up`}
                                    disabled={idx === 0}
                                    onClick={() =>
                                      moveItemByOffset(item.instrumentId, -1)
                                    }
                                    className="cursor-pointer rounded-[8px] p-1.5 text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-30"
                                  >
                                    <ArrowUp
                                      className="h-3.5 w-3.5"
                                      aria-hidden="true"
                                    />
                                  </button>
                                  <button
                                    type="button"
                                    aria-label={`Move ${formatSymbolForDisplay(item.symbol)} down`}
                                    disabled={
                                      idx === pricedDisplayedItems.length - 1
                                    }
                                    onClick={() =>
                                      moveItemByOffset(item.instrumentId, 1)
                                    }
                                    className="cursor-pointer rounded-[8px] p-1.5 text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-30"
                                  >
                                    <ArrowDown
                                      className="h-3.5 w-3.5"
                                      aria-hidden="true"
                                    />
                                  </button>
                                </>
                              )}

                              <button
                                type="button"
                                title="Simulate & price alerts"
                                aria-label={`Simulate and alerts for ${formatSymbolForDisplay(item.symbol)}`}
                                onClick={() => setSimulatingItem(item)}
                                className="inline-flex cursor-pointer items-center gap-1 rounded-[8px] border border-line bg-surface-2 px-2.5 py-1 text-[12px] font-medium text-ink-2 transition-colors hover:text-ink"
                              >
                                <Calculator
                                  className="h-3.5 w-3.5"
                                  aria-hidden="true"
                                />
                                <span>Sim</span>
                              </button>

                              {holdingsPortfolios.length > 0 && (
                                <button
                                  type="button"
                                  onClick={() => openConvertToBuy(item)}
                                  className="inline-flex cursor-pointer items-center gap-1 rounded-[8px] bg-accent/12 px-2.5 py-1 text-[12px] font-medium text-accent transition-colors hover:bg-accent hover:text-accent-ink"
                                >
                                  <ArrowRightLeft
                                    className="h-3.5 w-3.5"
                                    aria-hidden="true"
                                  />
                                  {item.paperShares ? "Convert" : "Buy"}
                                </button>
                              )}

                              <button
                                type="button"
                                aria-label={`Remove ${formatSymbolForDisplay(item.symbol)}`}
                                disabled={isRemoving}
                                onClick={() => void handleRemoveItem(item)}
                                className="cursor-pointer rounded-[8px] p-1.5 text-ink-2 transition-colors hover:bg-loss/10 hover:text-loss disabled:opacity-40"
                              >
                                {isRemoving ? (
                                  <Loader2
                                    className="h-3.5 w-3.5 animate-spin"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <Trash2
                                    className="h-3.5 w-3.5"
                                    aria-hidden="true"
                                  />
                                )}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </Card>

                  {/* Desktop Watchlist Table (>= 768px) */}
                  <Card className="hidden overflow-hidden md:block">
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-left text-[14px]">
                        <thead>
                          <tr className="border-b border-line text-[12px] font-medium text-ink-2">
                            {canReorder && (
                              <th className="w-16 py-3 pl-3 pr-1" />
                            )}
                            <th className="px-4 py-3">Instrument</th>
                            <th className="px-2.5 py-3">Trend</th>
                            <th className="px-2.5 py-3 text-right">Price</th>
                            <th className="px-2.5 py-3 text-right">
                              <span>Day</span>
                              <span className="block">Change</span>
                            </th>
                            <th className="px-3 py-3">52W Range</th>
                            <th className="px-3 py-3 text-right">
                              Alert Price
                            </th>
                            <th className="py-3 pl-3 pr-4 text-right">
                              Actions
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line">
                          {pricedDisplayedItems.map((item, idx) => {
                            const rowKey = `${item.portfolioId}::${item.instrumentId}`;
                            const isRemoving = removingKey === rowKey;
                            const detailHref = `/holdings/${encodeURIComponent(item.symbol)}`;
                            const exchangeLabel = formatExchangeCodeForDisplay(
                              item.exchangeCode,
                            );

                            return (
                              <tr
                                key={rowKey}
                                draggable={canReorder}
                                onClick={() => router.push(detailHref)}
                                onDragStart={() =>
                                  setDraggedInstrumentId(item.instrumentId)
                                }
                                onDragOver={(e) => {
                                  if (canReorder) {
                                    e.preventDefault();
                                  }
                                }}
                                onDrop={() =>
                                  handleDropOnItem(item.instrumentId)
                                }
                                onDragEnd={() => setDraggedInstrumentId(null)}
                                className={`cursor-pointer transition-colors hover:bg-surface-2 ${
                                  draggedInstrumentId === item.instrumentId
                                    ? "opacity-50"
                                    : ""
                                }`}
                              >
                                {canReorder && (
                                  <td
                                    className="py-3.5 pl-3 pr-1 align-middle"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <div className="flex items-center gap-0.5">
                                      <span
                                        className="cursor-grab p-0.5 text-ink-3"
                                        title="Drag to reorder"
                                      >
                                        <GripVertical
                                          className="h-3.5 w-3.5"
                                          aria-hidden="true"
                                        />
                                      </span>
                                      <button
                                        type="button"
                                        aria-label={`Move ${formatSymbolForDisplay(item.symbol)} up`}
                                        disabled={idx === 0}
                                        onClick={() =>
                                          moveItemByOffset(
                                            item.instrumentId,
                                            -1,
                                          )
                                        }
                                        className="cursor-pointer rounded p-0.5 text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-25"
                                      >
                                        <ArrowUp
                                          className="h-3.5 w-3.5"
                                          aria-hidden="true"
                                        />
                                      </button>
                                      <button
                                        type="button"
                                        aria-label={`Move ${formatSymbolForDisplay(item.symbol)} down`}
                                        disabled={
                                          idx ===
                                          pricedDisplayedItems.length - 1
                                        }
                                        onClick={() =>
                                          moveItemByOffset(
                                            item.instrumentId,
                                            1,
                                          )
                                        }
                                        className="cursor-pointer rounded p-0.5 text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-25"
                                      >
                                        <ArrowDown
                                          className="h-3.5 w-3.5"
                                          aria-hidden="true"
                                        />
                                      </button>
                                    </div>
                                  </td>
                                )}

                                <td className="px-4 py-3.5 align-middle">
                                  <div className="flex items-center gap-1.5">
                                    <Link
                                      href={detailHref}
                                      onClick={(e) => e.stopPropagation()}
                                      className="font-mono text-[14px] font-semibold text-ink hover:text-accent"
                                    >
                                      <span>{formatSymbolForDisplay(item.symbol)}</span>
                                    </Link>
                                    {(exchangeLabel || item.currency) && (
                                      <span className="rounded-[6px] bg-surface-2 px-1.5 py-0.5 text-[10.5px] font-medium text-ink-3">
                                        {exchangeLabel || item.currency}
                                      </span>
                                    )}
                                  </div>
                                  <p className="mt-0.5 max-w-[205px] truncate text-[12px] text-ink-2">
                                    {item.name ?? "—"}
                                  </p>
                                </td>

                                <td className="px-2.5 py-3 align-middle">
                                  <Sparkline
                                    values={item.sparkline}
                                    width={72}
                                    height={26}
                                  />
                                </td>

                                <td className="num whitespace-nowrap px-2.5 py-3 text-right align-middle">
                                  {isRefreshing && !item.unitPrice ? (
                                    <div className="space-y-1">
                                      <Skeleton className="ml-auto h-4 w-16" />
                                      <Skeleton className="ml-auto h-3 w-12" />
                                    </div>
                                  ) : item.unitPrice ? (
                                    <FlashPrice value={Number(item.unitPrice)}>
                                      <div className="font-medium text-ink">
                                        {formatMoney(
                                          item.unitPrice,
                                          item.currency,
                                        )}
                                      </div>
                                      <div
                                        title={item.freshnessLabel}
                                        className="font-mono text-[11px] text-ink-3"
                                      >
                                        {formatCompactFreshness(item.freshnessLabel)}
                                      </div>
                                    </FlashPrice>
                                  ) : (
                                    <span
                                      title={item.freshnessLabel}
                                      className="inline-flex rounded-[6px] bg-surface-2 px-2 py-0.5 text-[12px] text-ink-2"
                                    >
                                      {formatCompactFreshness(item.freshnessLabel)}
                                    </span>
                                  )}
                                </td>

                                <td className="whitespace-nowrap px-2.5 py-3 text-right align-middle">
                                  {item.dayChange !== null &&
                                  item.dayChangePercent !== null ? (
                                    <GainBadge
                                      amount={item.dayChange}
                                      currency={item.currency}
                                      percent={item.dayChangePercent}
                                      size="sm"
                                      layout="stacked"
                                    />
                                  ) : (
                                    <span className="text-ink-3">—</span>
                                  )}
                                </td>

                                <td className="px-3 py-3.5 align-middle">
                                  <Range52WBar item={item} />
                                </td>

                                <td
                                  className="whitespace-nowrap px-3 py-3.5 text-right align-middle"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <AlertPriceBadge
                                    item={item}
                                    onOpenModal={() => setSimulatingItem(item)}
                                    emptyFallback="dash"
                                  />
                                </td>

                                <td
                                  className="whitespace-nowrap py-3.5 pl-3 pr-4 text-right align-middle"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <div className="inline-flex items-center justify-end gap-1">
                                    <button
                                      type="button"
                                      title="Simulate & price alerts"
                                      aria-label={`Simulate and alerts for ${formatSymbolForDisplay(item.symbol)}`}
                                      onClick={() => setSimulatingItem(item)}
                                      className="inline-flex cursor-pointer items-center gap-1 rounded-[8px] border border-line bg-surface-2 px-2.5 py-1 text-[12px] font-medium text-ink-2 transition-colors hover:text-ink"
                                    >
                                      <Calculator
                                        className="h-3.5 w-3.5"
                                        aria-hidden="true"
                                      />
                                      <span>Sim</span>
                                      {item.paperShares &&
                                        item.paperGainPercent !== null && (
                                          <span
                                            className={`num font-semibold ${
                                              Number(item.paperGainPercent) >= 0
                                                ? "text-gain"
                                                : "text-loss"
                                            }`}
                                          >
                                            {formatPercent(
                                              item.paperGainPercent,
                                            )}
                                          </span>
                                        )}
                                    </button>

                                    {holdingsPortfolios.length > 0 && (
                                      <button
                                        type="button"
                                        title={
                                          item.paperShares
                                            ? "Convert paper position to Buy"
                                            : "Record a Buy transaction"
                                        }
                                        onClick={() => openConvertToBuy(item)}
                                        className="inline-flex cursor-pointer items-center gap-1 rounded-[8px] bg-accent/12 px-2.5 py-1 text-[12px] font-medium text-accent transition-colors hover:bg-accent hover:text-accent-ink"
                                      >
                                        <ArrowRightLeft
                                          className="h-3.5 w-3.5"
                                          aria-hidden="true"
                                        />
                                        <span>
                                          {item.paperShares ? "Convert" : "Buy"}
                                        </span>
                                      </button>
                                    )}

                                    <button
                                      type="button"
                                      aria-label={`Remove ${formatSymbolForDisplay(item.symbol)}`}
                                      disabled={isRemoving}
                                      onClick={() =>
                                        void handleRemoveItem(item)
                                      }
                                      className="cursor-pointer rounded-[8px] p-1.5 text-ink-2 transition-colors hover:bg-loss/10 hover:text-loss disabled:opacity-40"
                                    >
                                      {isRemoving ? (
                                        <Loader2
                                          className="h-3.5 w-3.5 animate-spin"
                                          aria-hidden="true"
                                        />
                                      ) : (
                                        <Trash2
                                          className="h-3.5 w-3.5"
                                          aria-hidden="true"
                                        />
                                      )}
                                    </button>

                                    <Link
                                      href={detailHref}
                                      aria-label={`Open ${formatSymbolForDisplay(item.symbol)} detail`}
                                      className="rounded-[8px] p-1 text-ink-2 transition-colors hover:text-ink"
                                    >
                                      <ChevronRight
                                        size={16}
                                        aria-hidden="true"
                                      />
                                    </Link>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                    </>
                  )}

                  {/* Dedicated Prices Not Found Section */}
                  {unpricedDisplayedItems.length > 0 && (
                    <Card className="overflow-hidden">
                      <div className="flex flex-col gap-3 border-b border-line px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <h2 className="text-[18px] font-semibold tracking-tight text-ink">
                              Prices Not Found
                            </h2>
                            <span className="num rounded-[8px] border border-line bg-surface-2 px-2 py-0.5 text-[12px] font-medium text-ink-2">
                              {unpricedDisplayedItems.length}
                            </span>
                          </div>
                          <p className="mt-1 text-[13px] text-ink-2">
                            Excluded from background quote polling. Retry lookup
                            or remove symbols that cannot be priced.
                          </p>
                          {retryFeedback && (
                            <p className="mt-1 text-[12.5px] font-medium text-accent">
                              {retryFeedback}
                            </p>
                          )}
                        </div>

                        {retryableNotFoundSymbols.length > 0 && (
                          <Button
                            type="button"
                            variant="secondary"
                            size="xs"
                            disabled={isRetrying}
                            onClick={() =>
                              void handleRetryLookup(retryableNotFoundSymbols)
                            }
                            className="shrink-0 self-start sm:self-center"
                          >
                            <span>
                              {isRetrying && retryingSymbol === "__all__"
                                ? "Retrying…"
                                : "Retry Lookup"}
                            </span>
                          </Button>
                        )}
                      </div>

                      <div className="divide-y divide-line">
                        {unpricedDisplayedItems.map((item) => {
                          const key = `${item.portfolioId}::${item.instrumentId}`;
                          const isRemoving = removingKey === key;
                          const isCrypto = item.assetType === "crypto";
                          const isNotFound = Boolean(
                            quotes[item.symbol]?.priceNotFound ??
                              item.isPriceNotFound,
                          );
                          const isRowRetrying =
                            isRetrying &&
                            (retryingSymbol === item.symbol ||
                              retryingSymbol === "__all__");
                          const transition = getSgxTickerTransition(
                            item.symbol,
                          );
                          const reasonLabel = isCrypto
                            ? "Crypto price disabled"
                            : transition
                              ? `Renamed to ${transition.newSymbol}`
                              : isNotFound
                                ? "Not found on providers"
                                : "Quote unavailable";
                          const exchangeLabel = formatExchangeCodeForDisplay(
                            item.exchangeCode,
                          );
                          const alertTarget =
                            item.alertBelow ?? item.alertAbove;

                          return (
                            <div
                              key={key}
                              className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <Link
                                    href={`/holdings/${encodeURIComponent(item.symbol)}`}
                                    className="font-mono text-[14.5px] font-semibold text-ink hover:text-accent"
                                  >
                                    {formatSymbolForDisplay(item.symbol)}
                                  </Link>
                                  {exchangeLabel && (
                                    <span className="rounded-[6px] bg-surface-2 px-1.5 py-0.5 text-[10.5px] font-medium text-ink-3">
                                      {exchangeLabel}
                                    </span>
                                  )}
                                  <span
                                    title={item.priceNotFoundReason ?? undefined}
                                    className={`rounded-[6px] px-2 py-0.5 text-[11.5px] font-medium ${
                                      isCrypto
                                        ? "bg-surface-2 text-ink-2"
                                        : "bg-accent/12 text-accent"
                                    }`}
                                  >
                                    {reasonLabel}
                                  </span>
                                </div>

                                <p className="mt-0.5 truncate text-[13px] text-ink-2">
                                  {item.name ?? "Unnamed instrument"}
                                  {alertTarget
                                    ? ` · Alert ${formatMoney(alertTarget, item.currency)}`
                                    : ""}
                                </p>
                                {transition && (
                                  <p className="mt-0.5 text-[12px] text-ink-3">
                                    {transition.reason}
                                  </p>
                                )}
                              </div>

                              <div className="flex flex-wrap items-center gap-1.5 sm:shrink-0">
                                {transition && (
                                  <Button
                                    type="button"
                                    variant="secondary"
                                    size="xs"
                                    onClick={() =>
                                      setMigrationTarget({
                                        instrumentId: item.instrumentId,
                                        transition,
                                        defaultApplyConsolidation: false,
                                      })
                                    }
                                  >
                                    <ArrowRightLeft
                                      size={14}
                                      strokeWidth={1.9}
                                      aria-hidden="true"
                                    />
                                    <span>
                                      Update to {transition.newSymbol}
                                    </span>
                                  </Button>
                                )}

                                {!isCrypto && (
                                  <Button
                                    type="button"
                                    variant="secondary"
                                    size="xs"
                                    disabled={isRetrying}
                                    onClick={() =>
                                      void handleRetryLookup([item.symbol])
                                    }
                                  >
                                    <span>
                                      {isRowRetrying ? "Retrying…" : "Retry"}
                                    </span>
                                  </Button>
                                )}

                                <Link
                                  href={`/holdings/${encodeURIComponent(item.symbol)}`}
                                  className="inline-flex h-8 items-center justify-center rounded-[10px] bg-accent/12 px-3 text-[12.5px] font-medium text-accent transition-colors hover:bg-accent/18"
                                >
                                  Details
                                </Link>

                                <Button
                                  type="button"
                                  variant="secondary"
                                  size="xs"
                                  disabled={isRemoving}
                                  onClick={() => void handleRemoveItem(item)}
                                  className="text-loss hover:text-loss"
                                >
                                  <span>
                                    {isRemoving ? "Removing…" : "Remove"}
                                  </span>
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </Card>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* Sheets */}
      {activeWatchlist && (
        <AddSymbolSheet
          isOpen={isAddSheetOpen}
          onClose={() => setIsAddSheetOpen(false)}
          portfolioId={activeWatchlist.id}
          portfolioName={activeWatchlist.name}
          existingSymbols={activeItemsOrdered.map((i) => i.symbol)}
          onAdded={() => router.refresh()}
        />
      )}

      <SimulateAlertsSheet
        item={simulatingItem}
        defaultBenchmark={defaultBenchmark}
        onClose={() => setSimulatingItem(null)}
        onSaved={() => router.refresh()}
      />

      <WatchlistManageSheet
        isOpen={isManageSheetOpen}
        activeWatchlist={activeWatchlist}
        totalWatchlists={watchlistPortfolios.length}
        onClose={() => setIsManageSheetOpen(false)}
        onCreated={(newId) => {
          setSelectedWatchlistId(newId);
          router.refresh();
        }}
        onUpdated={() => router.refresh()}
        onDeleted={(deletedId) => {
          if (selectedWatchlistId === deletedId) {
            const fallback = watchlistPortfolios.find(
              (w) => w.id !== deletedId,
            );
            setSelectedWatchlistId(fallback?.id ?? "");
          }
          router.refresh();
        }}
      />

      {convertTarget && (
        <TransactionSheet
          key={convertTarget.key}
          isOpen={true}
          onClose={() => setConvertTarget(null)}
          onSaved={() => {
            setConvertTarget(null);
            router.refresh();
          }}
          portfolios={portfolios}
          positions={positions}
          defaultStock={convertTarget.stock}
          defaultQuantity={convertTarget.quantity}
        />
      )}

      <TickerMigrationSheet
        key={
          migrationTarget
            ? `wl-migrate-${migrationTarget.instrumentId}-${migrationTarget.transition.newSymbol}`
            : "wl-migrate-closed"
        }
        target={migrationTarget}
        onClose={() => setMigrationTarget(null)}
        onMigrated={(targetSymbol) => {
          setMigrationTarget(null);
          setRetryFeedback(
            `Updated ticker to ${targetSymbol}. Fetching live SGX quote…`,
          );
          router.refresh();
        }}
      />
    </>
  );
}
