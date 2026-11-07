"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Briefcase,
  ChevronDown,
  ChevronRight,
  Plus,
  RefreshCw,
  Search,
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
import { useQuotesPoll } from "@/hooks/use-quotes-poll";
import { formatMoney, formatPercent, formatQuantity } from "@/lib/format";
import {
  buildValuedHoldings,
  type SerializedFifoBucket,
} from "@/lib/holdings/valuation";
import type { ResolvedInstrumentQuote } from "@/lib/market-data/batch-quotes";
import type { ExchangeRateSnapshot } from "@/lib/market-data/fx";
import type { CombinedMarketOverview } from "@/lib/market-data/hours";
import { springSmooth } from "@/lib/motion";
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

  const trackedSymbols = useMemo(
    () => [...new Set(buckets.map((b) => b.symbol))],
    [buckets],
  );

  const { quotes, fxUsdToSgd, isRefreshing, refreshNow } = useQuotesPoll({
    symbols: trackedSymbols,
    includeSparklines: true,
    enabled: trackedSymbols.length > 0,
    initialQuotes,
    initialFxUsdToSgd,
    initialMarket,
  });

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
            onClick={() => void refreshNow()}
            disabled={isRefreshing}
            className="h-10 px-3.5 text-[14px]"
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
          onClick={() => setIsTxSheetOpen(true)}
          className="h-10 w-full px-4 text-[14px] sm:w-auto"
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

      {/* Honest Data-Quality Callout for Unpriced Open Positions (Rule 5) */}
      {summary.unpricedOpenSymbols.length > 0 && (
        <Card className="flex items-start gap-3 px-4 py-3.5 sm:px-5 sm:py-4">
          <TriangleAlert
            size={18}
            className="mt-0.5 shrink-0 text-accent"
            aria-hidden="true"
          />
          <div className="text-[13.5px] leading-relaxed">
            <p className="font-medium text-ink">
              {summary.unpricedOpenSymbols.length} open position
              {summary.unpricedOpenSymbols.length === 1 ? " has" : "s have"} no
              live market price
            </p>
            <p className="mt-0.5 text-ink-2">
              Excluded from market-value totals rather than guessing:{" "}
              {summary.unpricedOpenSymbols.map((sym, idx) => (
                <span key={sym}>
                  {idx > 0 ? ", " : ""}
                  <Link
                    href={`/holdings/${encodeURIComponent(sym)}`}
                    className="font-mono font-medium text-accent hover:underline"
                  >
                    {sym}
                  </Link>
                </span>
              ))}
              . Open a symbol to set a manual price or mark it worthless.
            </p>
          </div>
        </Card>
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
              className="field-input h-9.5 bg-surface pl-8.5 pr-3 text-[14px]"
            />
          </div>
        </div>
      </div>

      {/* Mobile Apple Stocks-Style List (< 768px) */}
      <Card className="divide-y divide-line overflow-hidden md:hidden">
        {visibleRows.length === 0 ? (
          <div className="px-4 py-10 text-center text-[14px] text-ink-3">
            No {activeTab} positions match the current filter.
          </div>
        ) : (
          visibleRows.map((row) => {
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
                      <motion.span
                        layoutId={`holding-symbol-${row.symbol}`}
                        transition={springSmooth}
                        className="font-mono text-[15.5px] font-semibold text-ink"
                      >
                        {row.symbol}
                      </motion.span>
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

      {/* Desktop Financial Holdings Table (>= 768px) */}
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
              {visibleRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={activeTab === "open" ? 10 : 9}
                    className="px-4 py-12 text-center text-ink-3"
                  >
                    No {activeTab} positions match the current filter.
                  </td>
                </tr>
              ) : (
                visibleRows.map((row) => {
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
                            <motion.span
                              layoutId={`holding-symbol-${row.symbol}`}
                              transition={springSmooth}
                            >
                              {row.symbol}
                            </motion.span>
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

