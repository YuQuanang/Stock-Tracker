"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import {
  Briefcase,
  ChevronDown,
  ChevronRight,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  TriangleAlert,
} from "lucide-react";
import type { Portfolio } from "@/db/schema";
import { Sparkline } from "@/components/charts/sparkline";
import { TransactionSheet } from "@/components/transactions/transaction-sheet";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { GainBadge } from "@/components/ui/gain-badge";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet } from "@/components/ui/sheet";
import { useQuotesPoll } from "@/hooks/use-quotes-poll";
import { formatMoney, formatPercent, formatQuantity } from "@/lib/format";
import {
  buildValuedHoldings,
  type SerializedFifoBucket,
} from "@/lib/holdings/valuation";
import type { ResolvedInstrumentQuote } from "@/lib/market-data/batch-quotes";
import type { ExchangeRateSnapshot } from "@/lib/market-data/fx";
import type { CombinedMarketOverview } from "@/lib/market-data/hours";
import type { LedgerPositionSummary } from "@/lib/services/ledger";
import { formatExchangeCodeForDisplay } from "@/lib/transactions/form-logic";

type PositionTab = "open" | "closed";
type SortField = "value" | "unrealized" | "totalReturn" | "dayChange" | "symbol";

interface HoldingsViewProps {
  portfolios: Portfolio[];
  buckets: SerializedFifoBucket[];
  initialQuotes: Record<string, ResolvedInstrumentQuote>;
  initialFxUsdToSgd: ExchangeRateSnapshot | null;
  initialMarket: CombinedMarketOverview;
  baseCurrency: string;
}

interface OverrideTarget {
  instrumentId: string;
  symbol: string;
  currency: string;
  manualPrice: string | null;
  isDelisted: boolean;
}

export function HoldingsView({
  portfolios,
  buckets,
  initialQuotes,
  initialFxUsdToSgd,
  initialMarket,
  baseCurrency,
}: HoldingsViewProps) {
  const router = useRouter();
  const holdingsPortfolios = useMemo(
    () => portfolios.filter((p) => p.type === "holdings"),
    [portfolios],
  );

  const [selectedPortfolioId, setSelectedPortfolioId] = useState<string>("all");
  const [activeTab, setActiveTab] = useState<PositionTab>("open");
  const [sortField, setSortField] = useState<SortField>("value");
  const [searchQuery, setSearchQuery] = useState("");
  const [isTxSheetOpen, setIsTxSheetOpen] = useState(false);

  const [retryingSymbol, setRetryingSymbol] = useState<string | null>(null);
  const [retryFeedback, setRetryFeedback] = useState<string | null>(null);

  const [overrideTarget, setOverrideTarget] = useState<OverrideTarget | null>(
    null,
  );
  const [manualPriceInput, setManualPriceInput] = useState("");
  const [isDelistedInput, setIsDelistedInput] = useState(false);
  const [isSavingOverride, setIsSavingOverride] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);

  const trackedSymbols = useMemo(() => {
    const set = new Set<string>();
    for (const b of buckets) {
      if (
        Number(b.sharesHeld) > 0 &&
        b.assetType !== "crypto" &&
        !b.isDelisted &&
        !b.priceNotFound &&
        !initialQuotes[b.symbol]?.priceNotFound
      ) {
        set.add(b.symbol);
      }
    }
    return [...set];
  }, [buckets, initialQuotes]);

  const { quotes, fxUsdToSgd, isRefreshing, isRetrying, refreshNow, retrySymbols } =
    useQuotesPoll({
      symbols: trackedSymbols,
      includeSparklines: true,
      enabled: trackedSymbols.length > 0,
      initialQuotes,
      initialFxUsdToSgd,
      initialMarket,
    });

  const bucketBySymbol = useMemo(() => {
    const map = new Map<string, SerializedFifoBucket>();
    for (const b of buckets) {
      if (selectedPortfolioId !== "all" && b.portfolioId !== selectedPortfolioId) {
        continue;
      }
      if (!map.has(b.symbol)) {
        map.set(b.symbol, b);
      }
    }
    return map;
  }, [buckets, selectedPortfolioId]);

  const { rows: allValuedRows, summary } = useMemo(
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

  // Map buckets to LedgerPositionSummary so Sell All previews work in TransactionSheet
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

  const visibleRows = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    const filtered = allValuedRows.filter((row) => {
      if (activeTab === "open" && !row.isOpenPosition) {
        return false;
      }
      if (activeTab === "closed" && !row.isClosedPosition) {
        return false;
      }
      if (needle !== "") {
        const hay =
          `${row.symbol} ${row.name ?? ""} ${row.portfolioNames.join(" ")}`.toLowerCase();
        if (!hay.includes(needle)) {
          return false;
        }
      }
      return true;
    });

    function numVal(raw: string | null): number {
      if (raw === null) {
        return Number.NEGATIVE_INFINITY;
      }
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
    }

    return [...filtered].sort((a, b) => {
      if (sortField === "symbol") {
        return a.symbol.localeCompare(b.symbol);
      }
      if (sortField === "dayChange") {
        return (
          numVal(b.dayChangeInBase ?? b.dayChangeAmount) -
          numVal(a.dayChangeInBase ?? a.dayChangeAmount)
        );
      }
      if (sortField === "unrealized") {
        return (
          numVal(b.unrealizedPnlInBase ?? b.unrealizedPnl) -
          numVal(a.unrealizedPnlInBase ?? a.unrealizedPnl)
        );
      }
      if (sortField === "totalReturn") {
        return (
          numVal(b.totalReturnInBase ?? b.totalReturn) -
          numVal(a.totalReturnInBase ?? a.totalReturn)
        );
      }
      // Default `"value"`: open positions by SGD market value, closed by realized P&L
      if (activeTab === "closed") {
        return (
          numVal(b.realizedPnlInBase ?? b.realizedPnl) -
          numVal(a.realizedPnlInBase ?? a.realizedPnl)
        );
      }
      return (
        numVal(b.marketValueInBase ?? b.marketValue) -
        numVal(a.marketValueInBase ?? a.marketValue)
      );
    });
  }, [allValuedRows, activeTab, searchQuery, sortField]);

  const { pricedVisibleRows, notFoundOpenRows } = useMemo(() => {
    if (activeTab !== "open") {
      return {
        pricedVisibleRows: visibleRows,
        notFoundOpenRows: [] as typeof visibleRows,
      };
    }
    return {
      pricedVisibleRows: visibleRows.filter((row) => row.unitPrice !== null),
      notFoundOpenRows: visibleRows.filter((row) => row.unitPrice === null),
    };
  }, [visibleRows, activeTab]);

  const retryableNotFoundSymbols = useMemo(
    () =>
      notFoundOpenRows
        .filter((row) => {
          const bucket = bucketBySymbol.get(row.symbol);
          return row.assetType !== "crypto" && !bucket?.isDelisted;
        })
        .map((row) => row.symbol),
    [notFoundOpenRows, bucketBySymbol],
  );

  const hideEmptyPricedLists =
    activeTab === "open" &&
    pricedVisibleRows.length === 0 &&
    notFoundOpenRows.length > 0;

  function openOverrideSheet(symbol: string): void {
    const bucket = bucketBySymbol.get(symbol);
    if (!bucket) {
      return;
    }
    setOverrideTarget({
      instrumentId: bucket.instrumentId,
      symbol: bucket.symbol,
      currency: bucket.currency,
      manualPrice: bucket.manualPrice,
      isDelisted: bucket.isDelisted,
    });
    setManualPriceInput(bucket.manualPrice ?? "");
    setIsDelistedInput(bucket.isDelisted);
    setOverrideError(null);
  }

  async function saveOverride(payload: {
    manualPrice: string | null;
    isDelisted: boolean;
  }): Promise<void> {
    if (!overrideTarget) {
      return;
    }
    setIsSavingOverride(true);
    setOverrideError(null);
    try {
      const response = await fetch(
        `/api/instruments/${encodeURIComponent(overrideTarget.instrumentId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!response.ok) {
        const err = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(err?.error ?? `Save failed (${response.status})`);
      }
      setOverrideTarget(null);
      router.refresh();
    } catch (error) {
      setOverrideError(
        error instanceof Error ? error.message : "Failed to save price override.",
      );
    } finally {
      setIsSavingOverride(false);
    }
  }

  async function handleOverrideSubmit(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const trimmed = manualPriceInput.trim();
    if (trimmed !== "") {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setOverrideError("Enter a valid non-negative price (or leave blank).");
        return;
      }
    }
    await saveOverride({
      manualPrice: trimmed === "" ? null : trimmed,
      isDelisted: isDelistedInput,
    });
  }

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
        setRetryFeedback(`Found live quote for ${recovered.join(", ")}.`);
        router.refresh();
      } else {
        setRetryFeedback(
          `No live quote found for ${targetSymbols.join(", ")}.`,
        );
      }
    } finally {
      setRetryingSymbol(null);
    }
  }

  const tabOptions = useMemo(
    () => [
      { value: "open" as PositionTab, label: `Open (${summary.openCount})` },
      {
        value: "closed" as PositionTab,
        label: `Closed (${summary.closedCount})`,
      },
    ],
    [summary.openCount, summary.closedCount],
  );

  const realizedPlusDividendsBase = useMemo(() => {
    const realized = Number(summary.totalRealizedPnlInBase);
    const divs = Number(summary.totalDividendsInBase);
    return (
      (Number.isFinite(realized) ? realized : 0) +
      (Number.isFinite(divs) ? divs : 0)
    ).toFixed(2);
  }, [summary.totalRealizedPnlInBase, summary.totalDividendsInBase]);

  if (buckets.length === 0) {
    return (
      <>
        <EmptyState
          icon={Briefcase}
          title="No holdings yet"
          description="Import your Microsoft Start CSV or record your first Buy transaction to see live valuations, sparklines, and FIFO lot breakdowns."
          actions={
            <>
              {holdingsPortfolios.length > 0 && (
                <Button onClick={() => setIsTxSheetOpen(true)}>
                  <Plus size={18} strokeWidth={2} aria-hidden="true" />
                  <span>New Transaction</span>
                </Button>
              )}
              <ButtonLink
                href="/import-export"
                variant={holdingsPortfolios.length > 0 ? "secondary" : "primary"}
              >
                Import CSV
              </ButtonLink>
            </>
          }
        />

        <TransactionSheet
          key={isTxSheetOpen ? "holdings-empty-open" : "holdings-empty-closed"}
          isOpen={isTxSheetOpen}
          onClose={() => setIsTxSheetOpen(false)}
          onSaved={() => router.refresh()}
          portfolios={portfolios}
          positions={sheetPositions}
        />
      </>
    );
  }

  return (
    <div className="space-y-5">
      {/* Apple Toolbar: Portfolio Picker + Refresh + New Transaction */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[195px] flex-1 sm:flex-none">
            <select
              aria-label="Select portfolio"
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
              size={15}
              strokeWidth={2}
              aria-hidden="true"
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-3"
            />
          </div>

          <Button
            variant="secondary"
            size="sm"
            onClick={() => void refreshNow()}
            disabled={isRefreshing}
          >
            <RefreshCw
              size={15}
              strokeWidth={1.9}
              aria-hidden="true"
              className={isRefreshing ? "animate-spin" : undefined}
            />
            <span>{isRefreshing ? "Refreshing…" : "Refresh"}</span>
          </Button>
        </div>

        <Button
          size="sm"
          onClick={() => setIsTxSheetOpen(true)}
          className="w-full sm:w-auto"
        >
          <Plus size={17} strokeWidth={2.2} aria-hidden="true" />
          <span>New Transaction</span>
        </Button>
      </div>

      {/* Base-Currency KPI Summary Strip */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-4">
          <p className="text-[12px] font-medium text-ink-3">
            Open Market Value ({summary.baseCurrency})
          </p>
          <p className="num mt-1 text-[23px] font-semibold tracking-tight text-ink">
            {formatMoney(summary.totalMarketValueInBase, summary.baseCurrency)}
          </p>
          <p className="num mt-1 text-[12px] text-ink-3">
            Cost basis{" "}
            {formatMoney(summary.totalCostBasisInBase, summary.baseCurrency)}
          </p>
        </Card>

        <Card className="p-4">
          <p className="text-[12px] font-medium text-ink-3">
            Day Change ({summary.baseCurrency})
          </p>
          <div className="mt-1.5">
            <GainBadge
              amount={summary.totalDayChangeInBase}
              currency={summary.baseCurrency}
              percent={summary.totalDayChangePercent}
            />
          </div>
          <p className="num mt-1.5 text-[12px] text-ink-3">
            {fxUsdToSgd
              ? `1 USD = ${fxUsdToSgd.rate} SGD`
              : "USD/SGD rate unavailable"}
          </p>
        </Card>

        <Card className="p-4">
          <p className="text-[12px] font-medium text-ink-3">
            Unrealized P&L ({summary.baseCurrency})
          </p>
          <div className="mt-1.5">
            <GainBadge
              amount={summary.totalUnrealizedPnlInBase}
              currency={summary.baseCurrency}
              percent={summary.totalUnrealizedPnlPercent}
            />
          </div>
          <p className="mt-1.5 text-[12px] text-ink-3">
            Includes FX return vs purchase date
          </p>
        </Card>

        <Card className="p-4">
          <p className="text-[12px] font-medium text-ink-3">
            Realized + Dividends ({summary.baseCurrency})
          </p>
          <div className="mt-1.5">
            <GainBadge
              amount={realizedPlusDividendsBase}
              currency={summary.baseCurrency}
            />
          </div>
          <p className="num mt-1.5 text-[12px] text-ink-3">
            Dividends{" "}
            {formatMoney(summary.totalDividendsInBase, summary.baseCurrency)}
          </p>
        </Card>
      </div>

      {/* Compact Jump Pill for Unpriced Open Positions -> #not-found */}
      {summary.unpricedOpenSymbols.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-[14px] border border-line bg-surface px-4 py-2.5 text-[13px]">
          <div className="flex min-w-0 items-center gap-2 text-ink-2">
            <TriangleAlert
              size={16}
              className="shrink-0 text-accent"
              aria-hidden="true"
            />
            <span className="truncate">
              <strong className="font-semibold text-ink">
                {summary.unpricedOpenSymbols.length}
              </strong>{" "}
              open position
              {summary.unpricedOpenSymbols.length === 1 ? "" : "s"} without
              live prices excluded from market-value totals.
            </span>
          </div>
          <a
            href="#not-found"
            onClick={(event) => {
              if (activeTab !== "open") {
                event.preventDefault();
                setActiveTab("open");
                requestAnimationFrame(() => {
                  document
                    .getElementById("not-found")
                    ?.scrollIntoView({ behavior: "smooth" });
                });
              }
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-3 py-1 text-[12.5px] font-medium text-accent transition-colors hover:bg-surface-2/80"
          >
            <span>View not found</span>
            <ChevronRight size={13} aria-hidden="true" />
          </a>
        </div>
      )}

      {/* Open / Closed Segmented Control + Sort + Search */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <SegmentedControl
          ariaLabel="Position status"
          options={tabOptions}
          value={activeTab}
          onChange={setActiveTab}
          layoutId="holdings-open-closed"
        />

        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
          <div className="relative sm:w-[185px]">
            <select
              aria-label="Sort holdings"
              value={sortField}
              onChange={(event) =>
                setSortField(event.target.value as SortField)
              }
              className="field-input h-9.5 appearance-none bg-surface pr-8 text-[13.5px]"
            >
              <option value="value">
                {activeTab === "open" ? "Sort: Market value" : "Sort: Realized P&L"}
              </option>
              <option value="unrealized">Sort: Unrealized P&L</option>
              <option value="totalReturn">Sort: Total return</option>
              <option value="dayChange">Sort: Day change</option>
              <option value="symbol">Sort: Symbol A–Z</option>
            </select>
            <ChevronDown
              size={14}
              strokeWidth={2}
              aria-hidden="true"
              className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3"
            />
          </div>

          <div className="relative w-full sm:w-[220px]">
            <Search
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search ticker or name…"
              aria-label="Search holdings"
              className="field-input h-9.5 bg-surface pl-9.5 pr-3 text-[14px]"
            />
          </div>
        </div>
      </div>

      {/* Mobile Apple Stocks-Style List (< 768px) */}
      {!hideEmptyPricedLists && (
        <Card className="divide-y divide-line overflow-hidden md:hidden">
          {pricedVisibleRows.length === 0 ? (
            <div className="px-4 py-10 text-center text-[14px] text-ink-3">
              No {activeTab} positions match the current filter.
            </div>
          ) : (
            pricedVisibleRows.map((row) => {
            const detailHref = `/holdings/${encodeURIComponent(row.symbol)}`;
            return (
              <Link
                key={row.key}
                href={detailHref}
                className="block px-4 py-3.5 transition-colors hover:bg-surface-2/60"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-[15.5px] font-semibold text-ink">
                        {row.symbol}
                      </span>
                      {row.weightPercent && activeTab === "open" && (
                        <span className="num rounded-full bg-surface-2 px-1.5 py-0.5 text-[10.5px] font-medium text-ink-3">
                          {formatPercent(row.weightPercent, {
                            fractionDigits: 1,
                          })}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-[12.5px] text-ink-2">
                      {row.name ?? row.portfolioNames.join(", ")}
                    </p>
                  </div>

                  <Sparkline
                    values={row.sparklineCloses}
                    width={68}
                    height={26}
                  />

                  <div className="shrink-0 text-right">
                    <p className="num text-[15px] font-semibold text-ink">
                      {activeTab === "open"
                        ? row.marketValue
                          ? formatMoney(row.marketValue, row.currency)
                          : "Price unavailable"
                        : formatMoney(row.realizedPnl, row.currency, {
                            signed: true,
                          })}
                    </p>
                    <div className="mt-0.5 flex justify-end">
                      {activeTab === "open" ? (
                        <GainBadge
                          amount={row.unrealizedPnl}
                          currency={row.currency}
                          percent={row.unrealizedPnlPercent}
                          size="sm"
                        />
                      ) : (
                        <GainBadge
                          amount={row.totalReturn}
                          currency={row.currency}
                          percent={row.totalReturnPercent}
                          size="sm"
                        />
                      )}
                    </div>
                  </div>
                </div>

                <div className="num mt-2 flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-ink-3">
                  <span>
                    {activeTab === "open"
                      ? `${formatQuantity(row.sharesHeld)} sh · Avg ${formatMoney(row.averageCostPerShare, row.currency)}`
                      : `${row.closedTradeCount} closed trade${row.closedTradeCount === 1 ? "" : "s"} · Div ${formatMoney(row.dividendsReceived, row.currency)}`}
                  </span>
                  <span>
                    {row.unitPrice
                      ? `${formatMoney(row.unitPrice, row.currency)} · ${row.freshnessLabel}`
                      : row.freshnessLabel}
                  </span>
                </div>
              </Link>
            );
          })
        )}
      </Card>
      )}

      {/* Desktop Financial Holdings Table (>= 768px) */}
      {!hideEmptyPricedLists && (
        <Card className="hidden overflow-hidden md:block">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[13.5px]">
              <thead>
                <tr className="border-b border-line text-[11.5px] font-medium uppercase tracking-wide text-ink-3">
                  <th className="px-4 py-3">Instrument</th>
                  <th className="px-3 py-3">Trend</th>
                  <th className="px-3 py-3 text-right">
                    {activeTab === "open" ? "Shares / Avg Cost" : "Closed Trades"}
                  </th>
                  <th className="px-3 py-3 text-right">Price</th>
                  <th className="px-3 py-3 text-right">
                    {activeTab === "open" ? "Market Value" : "Dividends"}
                  </th>
                  <th className="px-3 py-3 text-right">Day Change</th>
                  <th className="px-3 py-3 text-right">
                    {activeTab === "open" ? "Unrealized P&L" : "Realized P&L"}
                  </th>
                  <th className="px-3 py-3 text-right">Total Return</th>
                  {activeTab === "open" && (
                    <th className="px-3 py-3 text-right">Weight</th>
                  )}
                  <th className="w-8 px-2 py-3" aria-label="Open detail" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {pricedVisibleRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={activeTab === "open" ? 10 : 9}
                      className="px-4 py-12 text-center text-ink-3"
                    >
                      No {activeTab} positions match the current filter.
                    </td>
                  </tr>
                ) : (
                  pricedVisibleRows.map((row) => {
                  const detailHref = `/holdings/${encodeURIComponent(row.symbol)}`;
                  const exchangeLabel = formatExchangeCodeForDisplay(
                    row.exchangeCode,
                  );

                  return (
                    <tr
                      key={row.key}
                      onClick={() => router.push(detailHref)}
                      className="cursor-pointer transition-colors hover:bg-surface-2/55"
                    >
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-1.5">
                          <Link
                            href={detailHref}
                            onClick={(e) => e.stopPropagation()}
                            className="font-mono text-[14.5px] font-semibold text-ink hover:text-accent"
                          >
                            <span>{row.symbol}</span>
                          </Link>
                          {exchangeLabel && (
                            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-ink-3">
                              {exchangeLabel}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 max-w-[210px] truncate text-[12px] text-ink-3">
                          {row.name ?? "—"}
                          {selectedPortfolioId === "all" &&
                          row.portfolioNames.length > 0
                            ? ` · ${row.portfolioNames.join(", ")}`
                            : ""}
                        </div>
                      </td>

                      <td className="px-3 py-3.5">
                        <Sparkline
                          values={row.sparklineCloses}
                          width={78}
                          height={26}
                        />
                      </td>

                      <td className="num whitespace-nowrap px-3 py-3.5 text-right">
                        {activeTab === "open" ? (
                          <>
                            <div className="font-medium text-ink">
                              {formatQuantity(row.sharesHeld)} sh
                            </div>
                            <div className="text-[12px] text-ink-3">
                              Avg{" "}
                              {formatMoney(
                                row.averageCostPerShare,
                                row.currency,
                                { maximumFractionDigits: 4 },
                              )}
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="font-medium text-ink">
                              {row.closedTradeCount} trade
                              {row.closedTradeCount === 1 ? "" : "s"}
                            </div>
                            <div className="text-[12px] text-ink-3">
                              Won {row.winningTradeCount}/{row.closedTradeCount}
                            </div>
                          </>
                        )}
                      </td>

                      <td className="num whitespace-nowrap px-3 py-3.5 text-right">
                        {row.unitPrice ? (
                          <>
                            <div className="font-medium text-ink">
                              {formatMoney(row.unitPrice, row.currency, {
                                maximumFractionDigits: 4,
                              })}
                            </div>
                            <div className="text-[11.5px] text-ink-3">
                              {row.freshnessLabel}
                            </div>
                          </>
                        ) : (
                          <span className="inline-flex rounded-full bg-surface-2 px-2 py-0.5 text-[11.5px] text-ink-3">
                            Price unavailable
                          </span>
                        )}
                      </td>

                      <td className="num whitespace-nowrap px-3 py-3.5 text-right">
                        {activeTab === "open" ? (
                          row.marketValue ? (
                            <>
                              <div className="font-semibold text-ink">
                                {formatMoney(row.marketValue, row.currency)}
                              </div>
                              {row.currency !== baseCurrency &&
                                row.marketValueInBase && (
                                  <div className="text-[11.5px] text-ink-3">
                                    {formatMoney(
                                      row.marketValueInBase,
                                      baseCurrency,
                                    )}
                                  </div>
                                )}
                            </>
                          ) : (
                            <span className="text-ink-3">—</span>
                          )
                        ) : (
                          <div className="font-medium text-ink">
                            {formatMoney(row.dividendsReceived, row.currency)}
                          </div>
                        )}
                      </td>

                      <td className="whitespace-nowrap px-3 py-3.5 text-right">
                        <GainBadge
                          amount={
                            activeTab === "open"
                              ? row.dayChangeAmount
                              : row.dayChangePerShare
                          }
                          currency={row.currency}
                          percent={row.dayChangePercent}
                          size="sm"
                        />
                      </td>

                      <td className="whitespace-nowrap px-3 py-3.5 text-right">
                        {activeTab === "open" ? (
                          <div>
                            <GainBadge
                              amount={row.unrealizedPnl}
                              currency={row.currency}
                              percent={row.unrealizedPnlPercent}
                              size="sm"
                            />
                            {row.currency !== baseCurrency &&
                              row.unrealizedPnlInBase && (
                                <div className="num mt-0.5 text-[11.5px] text-ink-3">
                                  {formatMoney(
                                    row.unrealizedPnlInBase,
                                    baseCurrency,
                                    { signed: true },
                                  )}
                                </div>
                              )}
                          </div>
                        ) : (
                          <div>
                            <GainBadge
                              amount={row.realizedPnl}
                              currency={row.currency}
                              size="sm"
                            />
                            {row.currency !== baseCurrency &&
                              row.realizedPnlInBase && (
                                <div className="num mt-0.5 text-[11.5px] text-ink-3">
                                  {formatMoney(
                                    row.realizedPnlInBase,
                                    baseCurrency,
                                    { signed: true },
                                  )}
                                </div>
                              )}
                          </div>
                        )}
                      </td>

                      <td className="whitespace-nowrap px-3 py-3.5 text-right">
                        <GainBadge
                          amount={row.totalReturn}
                          currency={row.currency}
                          percent={row.totalReturnPercent}
                          size="sm"
                        />
                      </td>

                      {activeTab === "open" && (
                        <td className="num whitespace-nowrap px-3 py-3.5 text-right text-ink-2">
                          {row.weightPercent
                            ? formatPercent(row.weightPercent, {
                                fractionDigits: 1,
                              })
                            : "—"}
                        </td>
                      )}

                      <td className="px-2 py-3.5 text-right text-ink-3">
                        <ChevronRight size={16} aria-hidden="true" />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>
      )}

      {/* Dedicated Prices Not Found Section */}
      {activeTab === "open" && notFoundOpenRows.length > 0 && (
        <div id="not-found" className="scroll-mt-24">
          <Card className="overflow-hidden">
          <div className="flex flex-col gap-3 border-b border-line px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-[15.5px] font-semibold tracking-tight text-ink">
                  Prices Not Found
                </h2>
                <span className="num rounded-full bg-surface-2 px-2 py-0.5 text-[11.5px] font-medium text-ink-2">
                  {notFoundOpenRows.length}
                </span>
              </div>
              <p className="mt-0.5 text-[12.5px] text-ink-3">
                Excluded from market-value totals and background quote polling.
                Set a manual price or retry provider lookup anytime.
              </p>
              {retryFeedback && (
                <p className="mt-1 text-[12px] font-medium text-accent">
                  {retryFeedback}
                </p>
              )}
            </div>

            {retryableNotFoundSymbols.length > 0 && (
              <Button
                variant="secondary"
                size="xs"
                shape="pill"
                disabled={isRetrying}
                onClick={() =>
                  void handleRetryLookup(retryableNotFoundSymbols)
                }
                className="shrink-0 self-start sm:self-center"
              >
                <RefreshCw
                  size={12}
                  strokeWidth={1.9}
                  aria-hidden="true"
                  className={
                    isRetrying && retryingSymbol === "__all__"
                      ? "animate-spin"
                      : undefined
                  }
                />
                <span>
                  {isRetrying && retryingSymbol === "__all__"
                    ? "Retrying…"
                    : "Retry Lookup"}
                </span>
              </Button>
            )}
          </div>

          <div className="divide-y divide-line">
            {notFoundOpenRows.map((row) => {
              const detailHref = `/holdings/${encodeURIComponent(row.symbol)}`;
              const bucket = bucketBySymbol.get(row.symbol);
              const quote = quotes[row.symbol];
              const isCrypto = row.assetType === "crypto";
              const isDelisted = Boolean(bucket?.isDelisted);
              const isNotFound = Boolean(
                quote?.priceNotFound ?? row.priceNotFound ?? bucket?.priceNotFound,
              );
              const isCanRetry = !isCrypto && !isDelisted;
              const reasonLabel = isCrypto
                ? "Crypto price disabled"
                : isDelisted
                  ? "Delisted"
                  : isNotFound
                    ? "Not found on providers"
                    : "Quote unavailable";
              const reasonDetail =
                !isCrypto && !isDelisted
                  ? (quote?.unavailableReason ?? bucket?.priceNotFoundReason)
                  : null;
              const exchangeLabel = formatExchangeCodeForDisplay(
                row.exchangeCode,
              );
              const isRowRetrying =
                isRetrying &&
                (retryingSymbol === row.symbol || retryingSymbol === "__all__");

              return (
                <div
                  key={row.key}
                  className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Link
                        href={detailHref}
                        className="font-mono text-[14.5px] font-semibold text-ink hover:text-accent"
                      >
                        {row.symbol}
                      </Link>
                      {exchangeLabel && (
                        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-ink-3">
                          {exchangeLabel}
                        </span>
                      )}
                      <span
                        title={reasonDetail ?? undefined}
                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          isCrypto || isDelisted
                            ? "bg-surface-2 text-ink-3"
                            : "bg-accent/10 text-accent"
                        }`}
                      >
                        {reasonLabel}
                      </span>
                    </div>

                    <p className="mt-0.5 truncate text-[12.5px] text-ink-2">
                      {row.name ?? "Unnamed instrument"}
                      {selectedPortfolioId === "all" &&
                      row.portfolioNames.length > 0
                        ? ` · ${row.portfolioNames.join(", ")}`
                        : ""}
                    </p>

                    <p className="num mt-1 text-[12px] text-ink-3">
                      {formatQuantity(row.sharesHeld)} sh · Avg{" "}
                      {formatMoney(row.averageCostPerShare, row.currency, {
                        maximumFractionDigits: 4,
                      })}{" "}
                      · Cost basis{" "}
                      {formatMoney(row.costBasis, row.currency)}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 sm:shrink-0">
                    {isCanRetry && (
                      <Button
                        variant="secondary"
                        size="xs"
                        shape="pill"
                        disabled={isRetrying}
                        onClick={() => void handleRetryLookup([row.symbol])}
                      >
                        <RefreshCw
                          size={12}
                          strokeWidth={1.9}
                          aria-hidden="true"
                          className={
                            isRowRetrying ? "animate-spin" : undefined
                          }
                        />
                        <span>{isRowRetrying ? "Retrying…" : "Retry"}</span>
                      </Button>
                    )}

                    {bucket && (
                      <Button
                        variant="tinted"
                        size="xs"
                        shape="pill"
                        onClick={() => openOverrideSheet(row.symbol)}
                      >
                        <SlidersHorizontal
                          size={12}
                          strokeWidth={1.9}
                          aria-hidden="true"
                        />
                        <span>Set Price</span>
                      </Button>
                    )}

                    <Link
                      href={detailHref}
                      aria-label={`Open ${row.symbol} details`}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
                    >
                      <ChevronRight size={15} aria-hidden="true" />
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
          </Card>
        </div>
      )}

      {/* Inline Price Override Sheet */}
      <Sheet
        isOpen={overrideTarget !== null}
        onClose={() => setOverrideTarget(null)}
        title={
          overrideTarget
            ? `Price override · ${overrideTarget.symbol}`
            : "Price override"
        }
        description="Override live market quotes for unlisted, suspended, crypto, or delisted positions."
      >
        {overrideTarget && (
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
                  Values the position at{" "}
                  {formatMoney(0, overrideTarget.currency)} unless a custom
                  liquidation/recovery price is entered below.
                </p>
              </div>
            </label>

            <div>
              <label
                htmlFor="holdings-override-manual-price"
                className="mb-1.5 block text-[13px] font-medium text-ink-2"
              >
                Manual unit price ({overrideTarget.currency})
              </label>
              <input
                id="holdings-override-manual-price"
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
              {overrideTarget.manualPrice !== null ||
              overrideTarget.isDelisted ? (
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
                  onClick={() => setOverrideTarget(null)}
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
        )}
      </Sheet>

      <TransactionSheet
        key={isTxSheetOpen ? "holdings-new-open" : "holdings-new-closed"}
        isOpen={isTxSheetOpen}
        onClose={() => setIsTxSheetOpen(false)}
        onSaved={() => router.refresh()}
        portfolios={portfolios}
        positions={sheetPositions}
        defaultPortfolioId={
          selectedPortfolioId !== "all" ? selectedPortfolioId : undefined
        }
      />
    </div>
  );
}

