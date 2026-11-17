"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowRight,
  ChartLine,
  CheckCircle2,
  ChevronDown,
  Coins,
  FileUp,
  Info,
  Plus,
  RefreshCw,
} from "lucide-react";
import { MetricTooltip } from "@/components/analytics/metric-tooltip";
import { AllocationDonut } from "@/components/charts/allocation-donut";
import { MoneyInvestedChart } from "@/components/charts/money-invested-chart";
import { PortfolioValueChart } from "@/components/charts/portfolio-value-chart";
import { Sparkline } from "@/components/charts/sparkline";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { GainBadge } from "@/components/ui/gain-badge";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { usePriceFlashRef } from "@/hooks/use-price-flash";
import { useQuotesPoll } from "@/hooks/use-quotes-poll";
import {
  CORE_COMPARISON_BENCHMARKS,
  computeReturnSpread,
} from "@/lib/benchmarks/summary";
import type { AnalyticsChartRange } from "@/lib/charts/theme";
import { formatMoney, formatPercent } from "@/lib/format";
import { fadeQuick, springSmooth } from "@/lib/motion";
import { formatSymbolForDisplay } from "@/lib/transactions/form-logic";
import type {
  MoverViewRow,
  PortfolioAnalyticsSnapshot,
} from "@/lib/services/analytics";

interface DashboardViewProps {
  initialSnapshot: PortfolioAnalyticsSnapshot;
  hydrateLiveOnMount?: boolean;
}

const DEFAULT_MOVER_PREVIEW_COUNT = 2;

const CURRENCY_OPTIONS: readonly SegmentedOption<"SGD" | "USD">[] = [
  { value: "SGD", label: "SGD" },
  { value: "USD", label: "USD" },
];

function buildDashboardHeadline(
  summary: PortfolioAnalyticsSnapshot["summary"],
  performance: PortfolioAnalyticsSnapshot["performance"],
  currency: "SGD" | "USD",
): string {
  const dayPct =
    summary.totalDayChangePercent !== null
      ? Number(summary.totalDayChangePercent)
      : Number.NaN;
  if (Number.isFinite(dayPct) && Math.abs(dayPct) >= 0.01) {
    const dir = dayPct > 0 ? "up" : "down";
    return `Your portfolio is ${dir} ${Math.abs(dayPct).toFixed(2)}% today`;
  }
  const cumTwr =
    performance.cumulativeTwrPercent !== null
      ? Number(performance.cumulativeTwrPercent)
      : Number.NaN;
  if (Number.isFinite(cumTwr) && Math.abs(cumTwr) >= 0.01) {
    const dir = cumTwr > 0 ? "up" : "down";
    return `Your portfolio is ${dir} ${Math.abs(cumTwr).toFixed(1)}% overall`;
  }
  return `Portfolio overview in ${currency}`;
}

function MoverItemRow({
  row,
  mode,
  currency,
}: {
  row: MoverViewRow;
  mode: "today" | "all-time";
  currency: "SGD" | "USD";
}) {
  const pct =
    mode === "today" ? row.dayChangePercent : row.unrealizedPnlPercent;
  const amt =
    mode === "today" ? row.dayChangeInBase : row.unrealizedPnlInBase;

  return (
    <Link
      href={`/holdings/${encodeURIComponent(row.symbol)}`}
      className="-mx-1.5 flex items-center justify-between gap-3 rounded-[10px] px-2 py-2 text-[14px] transition-colors hover:bg-surface-2"
    >
      <div className="min-w-0">
        <p className="font-mono truncate text-[13.5px] font-semibold text-ink">
          {row.displaySymbol}
        </p>
        <p className="truncate text-[12px] text-ink-2">
          {row.name ?? row.symbol}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <GainBadge
          amount={amt}
          currency={currency}
          percent={pct}
          size="sm"
        />
      </div>
    </Link>
  );
}

function MoverListSection({
  title,
  emptyLabel,
  rows,
  mode,
  currency,
  isExpanded,
}: {
  title: string;
  emptyLabel: string;
  rows: readonly MoverViewRow[];
  mode: "today" | "all-time";
  currency: "SGD" | "USD";
  isExpanded: boolean;
}) {
  const previewRows = rows.slice(0, DEFAULT_MOVER_PREVIEW_COUNT);
  const extraRows = rows.slice(DEFAULT_MOVER_PREVIEW_COUNT);

  return (
    <div>
      <p className="text-[12px] font-medium uppercase tracking-[0.04em] text-ink-3">
        {title}
      </p>
      {rows.length === 0 ? (
        <p className="mt-2 text-[13px] text-ink-2">{emptyLabel}</p>
      ) : (
        <div className="mt-2">
          <ul className="divide-y divide-line">
            {previewRows.map((row) => (
              <li key={row.symbol}>
                <MoverItemRow row={row} mode={mode} currency={currency} />
              </li>
            ))}
          </ul>

          <AnimatePresence initial={false}>
            {isExpanded && extraRows.length > 0 && (
              <motion.ul
                initial={{ opacity: 0, height: 0 }}
                animate={{
                  opacity: 1,
                  height: "auto",
                  transition: { ...springSmooth, opacity: fadeQuick },
                }}
                exit={{
                  opacity: 0,
                  height: 0,
                  transition: { ...fadeQuick, opacity: { duration: 0.1 } },
                }}
                className="divide-y divide-line overflow-hidden border-t border-line"
              >
                {extraRows.map((row) => (
                  <li key={row.symbol}>
                    <MoverItemRow row={row} mode={mode} currency={currency} />
                  </li>
                ))}
              </motion.ul>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

function MoverSummaryCard({
  title,
  headerRight,
  primaryTitle,
  primaryEmpty,
  primaryRows,
  secondaryTitle,
  secondaryEmpty,
  secondaryRows,
  mode,
  currency,
}: {
  title: string;
  headerRight: ReactNode;
  primaryTitle: string;
  primaryEmpty: string;
  primaryRows: readonly MoverViewRow[];
  secondaryTitle: string;
  secondaryEmpty: string;
  secondaryRows: readonly MoverViewRow[];
  mode: "today" | "all-time";
  currency: "SGD" | "USD";
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const hiddenCount =
    Math.max(0, primaryRows.length - DEFAULT_MOVER_PREVIEW_COUNT) +
    Math.max(0, secondaryRows.length - DEFAULT_MOVER_PREVIEW_COUNT);

  return (
    <Card className="space-y-4 p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[16px] font-semibold tracking-[-0.015em] text-ink">
          {title}
        </h2>
        {headerRight}
      </div>

      <MoverListSection
        title={primaryTitle}
        emptyLabel={primaryEmpty}
        rows={primaryRows}
        mode={mode}
        currency={currency}
        isExpanded={isExpanded}
      />

      <MoverListSection
        title={secondaryTitle}
        emptyLabel={secondaryEmpty}
        rows={secondaryRows}
        mode={mode}
        currency={currency}
        isExpanded={isExpanded}
      />

      {hiddenCount > 0 && (
        <div className="border-t border-line pt-2.5">
          <button
            type="button"
            onClick={() => setIsExpanded((prev) => !prev)}
            aria-expanded={isExpanded}
            className="flex w-full items-center justify-center gap-1.5 rounded-[10px] py-1.5 text-[13px] font-medium text-accent transition-colors hover:bg-surface-2"
          >
            <span>
              {isExpanded ? "Show fewer" : `Show ${hiddenCount} more`}
            </span>
            <ChevronDown
              size={16}
              strokeWidth={1.75}
              aria-hidden="true"
              className={`transition-transform duration-150 ${
                isExpanded ? "rotate-180" : ""
              }`}
            />
          </button>
        </div>
      )}
    </Card>
  );
}

/**
 * Interactive Portfolio Overview Dashboard (`components/dashboard/dashboard-view.tsx`).
 */
export function DashboardView({
  initialSnapshot,
  hydrateLiveOnMount = false,
}: DashboardViewProps) {
  const [snapshot, setSnapshot] =
    useState<PortfolioAnalyticsSnapshot>(initialSnapshot);
  const [selectedPortfolioId, setSelectedPortfolioId] = useState<string>(
    initialSnapshot.scope.portfolioFilterId,
  );
  const [selectedCurrency, setSelectedCurrency] = useState<"SGD" | "USD">(
    initialSnapshot.scope.currency,
  );
  const [isLoadingScope, setIsLoadingScope] = useState(false);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [isQualityExpanded, setIsQualityExpanded] = useState(false);
  const [isAllocationExpanded, setIsAllocationExpanded] = useState(false);
  const [valueChartRange, setValueChartRange] =
    useState<AnalyticsChartRange>("1Y");
  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const didHydrateLiveRef = useRef(false);
  const snapshotCacheRef = useRef<Map<string, PortfolioAnalyticsSnapshot>>(
    new Map(),
  );

  useEffect(() => {
    const key = `${initialSnapshot.scope.portfolioFilterId}::${initialSnapshot.scope.currency}`;
    snapshotCacheRef.current.set(key, initialSnapshot);
  }, [initialSnapshot]);

  useEffect(() => {
    if (
      !hydrateLiveOnMount ||
      didHydrateLiveRef.current ||
      initialSnapshot.accountHasNoTransactions
    ) {
      return;
    }

    const seq = ++requestSeqRef.current;
    const controller = new AbortController();
    abortRef.current = controller;

    const qs = new URLSearchParams({
      portfolioId: initialSnapshot.scope.portfolioFilterId,
      currency: initialSnapshot.scope.currency,
      benchmarks: CORE_COMPARISON_BENCHMARKS.map((b) => b.symbol).join(","),
      includeBenchmarks: "true",
      includeFundamentals: "true",
    });

    void fetch(`/api/analytics?${qs.toString()}`, {
      signal: controller.signal,
    })
      .then((res) =>
        res.ok ? (res.json() as Promise<PortfolioAnalyticsSnapshot>) : null,
      )
      .then((fresh) => {
        if (!fresh || seq !== requestSeqRef.current) {
          return;
        }
        didHydrateLiveRef.current = true;
        snapshotCacheRef.current.set(
          `${fresh.scope.portfolioFilterId}::${fresh.scope.currency}`,
          fresh,
        );
        setSnapshot(fresh);
      })
      .catch(() => {
        // Keep the instant DB-cached SSR snapshot if offline or aborted.
      });

    return () => {
      controller.abort();
    };
  }, [
    hydrateLiveOnMount,
    initialSnapshot.accountHasNoTransactions,
    initialSnapshot.scope.portfolioFilterId,
    initialSnapshot.scope.currency,
  ]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const openNonCryptoSymbols = snapshot.holdings
    .filter(
      (h) =>
        h.isOpenPosition &&
        !h.isDelisted &&
        !h.priceNotFound &&
        !snapshot.quotes[h.symbol]?.priceNotFound,
    )
    .map((h) => h.symbol);

  const unpricedOpenHoldings = snapshot.holdings
    .filter((h) => h.isOpenPosition && h.unitPrice === null)
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  const retryableNotFoundSymbols = unpricedOpenHoldings
    .filter((h) => !h.isDelisted)
    .map((h) => h.symbol);

  const livePoll = useQuotesPoll({
    symbols: openNonCryptoSymbols,
    enabled: !snapshot.accountHasNoTransactions && openNonCryptoSymbols.length > 0,
    skipInitialFetch: hydrateLiveOnMount,
    initialQuotes: snapshot.quotes,
    initialFxUsdToSgd: snapshot.fxUsdToSgd,
    initialMarket: snapshot.market,
  });

  async function loadAnalyticsScope(next: {
    portfolioId: string;
    currency: "SGD" | "USD";
    forceRefresh?: boolean;
  }) {
    const cacheKey = `${next.portfolioId}::${next.currency}`;
    if (next.forceRefresh) {
      snapshotCacheRef.current.clear();
    } else {
      snapshotCacheRef.current.set(
        `${snapshot.scope.portfolioFilterId}::${snapshot.scope.currency}`,
        snapshot,
      );
      const cached = snapshotCacheRef.current.get(cacheKey);
      if (cached) {
        abortRef.current?.abort();
        requestSeqRef.current += 1;
        setSnapshot(cached);
        setSelectedPortfolioId(cached.scope.portfolioFilterId);
        setSelectedCurrency(cached.scope.currency);
        setIsLoadingScope(false);
        setScopeError(null);
        return;
      }
    }

    const seq = ++requestSeqRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Optimistically move controls in 0ms while fresh scoped analytics load.
    setSelectedPortfolioId(next.portfolioId);
    setSelectedCurrency(next.currency);
    setIsLoadingScope(true);
    setScopeError(null);
    try {
      const qs = new URLSearchParams({
        portfolioId: next.portfolioId,
        currency: next.currency,
        benchmarks: CORE_COMPARISON_BENCHMARKS.map((b) => b.symbol).join(","),
        includeBenchmarks: "true",
        includeFundamentals: "true",
      });
      if (next.forceRefresh) {
        qs.set("forceRefresh", "true");
      } else if (next.portfolioId === snapshot.scope.portfolioFilterId) {
        // Currency toggles on the current portfolio reuse warm server/DB caches in milliseconds.
        qs.set("cacheOnly", "true");
      }
      const res = await fetch(`/api/analytics?${qs.toString()}`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Unable to update dashboard view.");
      }
      const fresh = (await res.json()) as PortfolioAnalyticsSnapshot;
      snapshotCacheRef.current.set(
        `${fresh.scope.portfolioFilterId}::${fresh.scope.currency}`,
        fresh,
      );
      if (seq === requestSeqRef.current) {
        setSnapshot(fresh);
        setSelectedPortfolioId(fresh.scope.portfolioFilterId);
        setSelectedCurrency(fresh.scope.currency);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      if (seq === requestSeqRef.current) {
        setSelectedPortfolioId(snapshot.scope.portfolioFilterId);
        setSelectedCurrency(snapshot.scope.currency);
        setScopeError(
          error instanceof Error
            ? error.message
            : "Unable to reload analytics snapshot.",
        );
      }
    } finally {
      if (seq === requestSeqRef.current) {
        setIsLoadingScope(false);
      }
    }
  }

  const totalValueFlashRef = usePriceFlashRef<HTMLParagraphElement>(
    Number(snapshot.summary.totalMarketValueInBase),
  );

  if (snapshot.accountHasNoTransactions) {
    return (
      <div className="space-y-6">
        <EmptyState
          icon={FileUp}
          title="Welcome to Kestrel"
          description="Bring in your existing portfolio from a Microsoft Start / MSN Money CSV export, or add transactions manually to unlock live FIFO lots, historical valuation charts, XIRR/TWR analytics, and global benchmark comparisons."
          actions={
            <>
              <ButtonLink href="/import-export">
                <FileUp size={16} strokeWidth={1.75} aria-hidden="true" />
                Import my CSV
              </ButtonLink>
              <ButtonLink href="/transactions" variant="secondary">
                <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
                Add first transaction
              </ButtonLink>
            </>
          }
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Card className="p-5">
            <p className="text-[12px] font-medium text-ink-2">
              1. Exact Ledger Math
            </p>
            <p className="mt-1.5 text-[14px] leading-[1.5] text-ink-2">
              Every Buy, Sell, Sell All, and Dividend is evaluated chronologically
              with Decimal.js FIFO lot matching and historical purchase-date FX rates.
            </p>
          </Card>
          <Card className="p-5">
            <p className="text-[12px] font-medium text-ink-2">
              2. Honest Pricing
            </p>
            <p className="mt-1.5 text-[14px] leading-[1.5] text-ink-2">
              Stocks &amp; ETFs sync automatically from market providers. Closed or
              obscure assets never invent synthetic prices or fake -100% drops.
            </p>
          </Card>
          <Card className="p-5">
            <p className="text-[12px] font-medium text-ink-2">
              3. Benchmark Ready
            </p>
            <p className="mt-1.5 text-[14px] leading-[1.5] text-ink-2">
              Compare your Time-Weighted Return and cash flows directly against the
              S&amp;P 500, NASDAQ, Dow Jones, and Straits Times Index in one currency.
            </p>
          </Card>
        </div>
      </div>
    );
  }

  const currency = snapshot.scope.currency;
  const locale = snapshot.settings.numberFormat;
  const { summary, performance, dividends, dataQuality } = snapshot;

  const currentFxRate = livePoll.fxUsdToSgd?.rate ?? snapshot.fxUsdToSgd?.rate;
  const totalRealizedAndDividends =
    Number(summary.totalRealizedPnlInBase) +
    Number(summary.totalDividendsInBase);
  const heroHeadline = buildDashboardHeadline(summary, performance, currency);
  const recentSparkValues = snapshot.timeline.points
    .slice(-30)
    .map((point) => point.portfolioValue);

  const cryptoNotFoundCount = unpricedOpenHoldings.filter(
    (item) => item.assetType === "crypto",
  ).length;
  const providerNotFoundCount =
    unpricedOpenHoldings.length - cryptoNotFoundCount;
  const visibleUnpriced = unpricedOpenHoldings.slice(0, 8);
  const extraUnpricedCount =
    unpricedOpenHoldings.length - visibleUnpriced.length;

  return (
    <div className="space-y-6">
      {/* Top Hero Band: grainy blue-grey gradient permitted on dashboard hero ONLY */}
      <section
        aria-label="Portfolio summary hero"
        className="hero-band-grain rounded-[var(--radius-card)] border border-line p-5 sm:p-6"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-balance text-[18px] font-semibold leading-snug tracking-[-0.015em] text-ink sm:text-[20px]">
              {heroHeadline}
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-ink-2">
              <span>{livePoll.market.badgeLabel}</span>
              {currentFxRate && (
                <>
                  <span className="text-ink-3" aria-hidden="true">·</span>
                  <span className="num">
                    1 USD = {Number(currentFxRate).toFixed(4)} SGD
                  </span>
                </>
              )}
              {snapshot.timeline.firstTransactionDate && (
                <>
                  <span className="text-ink-3" aria-hidden="true">·</span>
                  <span>
                    Since{" "}
                    <span className="font-mono">
                      {snapshot.timeline.firstTransactionDate}
                    </span>
                  </span>
                </>
              )}
            </p>
          </div>

          {/* Scope & Currency Controls */}
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="dashboard-portfolio-filter">
              Portfolio scope
            </label>
            <div className="relative inline-flex items-center">
              <select
                id="dashboard-portfolio-filter"
                value={selectedPortfolioId}
                onChange={(e) =>
                  void loadAnalyticsScope({
                    portfolioId: e.target.value,
                    currency: selectedCurrency,
                  })
                }
                className="field-input h-9 appearance-none bg-surface pr-8 text-[13px] font-medium"
              >
                <option value="all">
                  All Portfolios ({snapshot.portfolios.length})
                </option>
                {snapshot.portfolios.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={16}
                strokeWidth={1.75}
                className="pointer-events-none absolute right-2.5 text-ink-2"
                aria-hidden="true"
              />
            </div>

            <SegmentedControl
              ariaLabel="Dashboard comparison currency"
              options={CURRENCY_OPTIONS}
              value={selectedCurrency}
              layoutId="dashboard-currency-seg"
              size="sm"
              onChange={(nextCurrency) => {
                if (nextCurrency !== selectedCurrency) {
                  void loadAnalyticsScope({
                    portfolioId: selectedPortfolioId,
                    currency: nextCurrency,
                  });
                }
              }}
            />

            <Button
              variant="secondary"
              size="sm"
              disabled={isLoadingScope}
              onClick={() =>
                void loadAnalyticsScope({
                  portfolioId: selectedPortfolioId,
                  currency: selectedCurrency,
                  forceRefresh: true,
                })
              }
            >
              <RefreshCw
                size={16}
                strokeWidth={1.75}
                className={isLoadingScope ? "animate-spin" : undefined}
                aria-hidden="true"
              />
              {isLoadingScope ? "Updating…" : "Refresh"}
            </Button>
          </div>
        </div>

        {/* Hero Value + Day Change + Compact Flat Sparkline */}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-t border-line pt-5">
          <div className="min-w-0 space-y-1">
            <p className="text-[12px] font-medium text-ink-2">
              Total Portfolio Value ({currency})
            </p>
            <div className="flex flex-wrap items-baseline gap-3">
              <p
                ref={totalValueFlashRef}
                className="num inline-block rounded-[8px] px-1 -mx-1 text-[32px] font-semibold leading-none tracking-[-0.025em] text-ink"
              >
                {formatMoney(summary.totalMarketValueInBase, currency, {
                  locale,
                })}
              </p>
              <div className="flex items-center gap-1.5 text-[14px]">
                <span className="text-[12px] text-ink-2">Today:</span>
                <GainBadge
                  amount={summary.totalDayChangeInBase}
                  currency={currency}
                  percent={summary.totalDayChangePercent}
                  size="sm"
                />
              </div>
            </div>
          </div>

          {recentSparkValues.length >= 2 && (
            <div className="flex items-center gap-3 rounded-[12px] border border-line bg-surface px-3.5 py-2.5">
              <div>
                <p className="text-[11px] text-ink-3">30D trend</p>
                <p className="num text-[12px] font-medium text-ink-2">
                  {summary.openCount} open
                </p>
              </div>
              <Sparkline
                values={recentSparkValues}
                width={104}
                height={32}
                tone="accent"
              />
            </div>
          )}
        </div>
      </section>

      {scopeError && (
        <div
          role="alert"
          className="rounded-[12px] border border-loss/35 bg-loss/10 px-4 py-2.5 text-[13px] text-loss"
        >
          {scopeError}
        </div>
      )}

      <div
        className={`space-y-6 transition-opacity duration-150 ${
          isLoadingScope ? "opacity-65" : "opacity-100"
        }`}
      >
        {/* Row 1: Secondary Performance Metric Cards (Apple-style balanced 3-part anatomy) */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Card className="flex flex-col justify-between p-5">
            <div>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <p className="text-[12.5px] font-medium text-ink-2">
                    Unrealized P&amp;L
                  </p>
                  <MetricTooltip
                    label="Unrealized P&L"
                    explanation="Profit or loss on shares you still hold today, comparing current market value against remaining FIFO purchase cost."
                  />
                </div>
                <GainBadge
                  percent={summary.totalUnrealizedPnlPercent}
                  size="sm"
                  pill
                />
              </div>
              <p
                className={`num mt-2.5 text-[24px] font-semibold leading-tight tracking-[-0.02em] ${
                  Number(summary.totalUnrealizedPnlInBase) > 0
                    ? "text-gain"
                    : Number(summary.totalUnrealizedPnlInBase) < 0
                      ? "text-loss"
                      : "text-ink"
                }`}
              >
                {formatMoney(summary.totalUnrealizedPnlInBase, currency, {
                  locale,
                  signed: true,
                })}
              </p>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-3">
              <div>
                <dt className="text-[11px] font-medium text-ink-3">
                  Open Cost Basis
                </dt>
                <dd className="num mt-0.5 text-[13px] font-medium text-ink">
                  {formatMoney(summary.totalCostBasisInBase, currency, {
                    locale,
                  })}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium text-ink-3">
                  Market Value
                </dt>
                <dd className="num mt-0.5 text-[13px] font-medium text-ink">
                  {formatMoney(summary.totalMarketValueInBase, currency, {
                    locale,
                  })}
                </dd>
              </div>
            </dl>
          </Card>

          <Card className="flex flex-col justify-between p-5">
            <div>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <p className="text-[12.5px] font-medium text-ink-2">
                    Realized &amp; Dividends
                  </p>
                  <MetricTooltip
                    label="Realized P&L + Dividends"
                    explanation="Locked-in net gains from closed trades plus net after-tax dividends collected across the selected portfolio scope."
                  />
                </div>
                {performance.winRatePercent && (
                  <span className="num rounded-[8px] border border-line bg-surface-2 px-2 py-0.5 text-[11.5px] font-medium text-ink-2">
                    {performance.winRatePercent}% win rate
                  </span>
                )}
              </div>
              <p
                className={`num mt-2.5 text-[24px] font-semibold leading-tight tracking-[-0.02em] ${
                  totalRealizedAndDividends > 0
                    ? "text-gain"
                    : totalRealizedAndDividends < 0
                      ? "text-loss"
                      : "text-ink"
                }`}
              >
                {formatMoney(totalRealizedAndDividends, currency, {
                  locale,
                  signed: true,
                })}
              </p>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-3">
              <div>
                <dt className="text-[11px] font-medium text-ink-3">
                  Realized P&amp;L
                </dt>
                <dd className="num mt-0.5 text-[13px] font-medium text-ink">
                  {formatMoney(summary.totalRealizedPnlInBase, currency, {
                    locale,
                    signed: true,
                  })}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium text-ink-3">
                  Dividends (Net)
                </dt>
                <dd className="num mt-0.5 text-[13px] font-medium text-ink">
                  {formatMoney(summary.totalDividendsInBase, currency, {
                    locale,
                  })}
                </dd>
              </div>
            </dl>
          </Card>

          <Card className="flex flex-col justify-between p-5">
            <div>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <p className="text-[12.5px] font-medium text-ink-2">
                    Returns (XIRR, TWR &amp; ROI)
                  </p>
                  <MetricTooltip
                    label="Annualized XIRR, TWR & ROI"
                    explanation="Annualized XIRR measures your personal money-weighted return including deposits & withdrawals. Annualized & Cumulative TWR measure pure portfolio strategy skill independent of cash-flow timing. ROI measures total dollar profit divided by total capital put in."
                  />
                </div>
                <span className="rounded-[8px] border border-line bg-surface-2 px-2 py-0.5 text-[11.5px] font-medium text-ink-2">
                  Ann. XIRR
                </span>
              </div>
              <p
                className={`num mt-2.5 text-[24px] font-semibold leading-tight tracking-[-0.02em] ${
                  performance.xirrPercent === null
                    ? "text-ink-2"
                    : Number(performance.xirrPercent) > 0
                      ? "text-gain"
                      : Number(performance.xirrPercent) < 0
                        ? "text-loss"
                        : "text-ink"
                }`}
              >
                {performance.xirrPercent !== null
                  ? formatPercent(performance.xirrPercent, { signed: true })
                  : "—"}
              </p>
            </div>
            <dl className="mt-4 grid grid-cols-3 gap-2 border-t border-line pt-3">
              <div>
                <dt className="text-[11px] font-medium text-ink-3">Ann. TWR</dt>
                <dd className="mt-0.5">
                  <GainBadge
                    percent={performance.annualizedTwrPercent}
                    size="sm"
                  />
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium text-ink-3">Cum. TWR</dt>
                <dd className="mt-0.5">
                  <GainBadge
                    percent={performance.cumulativeTwrPercent}
                    size="sm"
                  />
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium text-ink-3">Total ROI</dt>
                <dd className="mt-0.5">
                  <GainBadge percent={performance.roiPercent} size="sm" />
                </dd>
              </div>
            </dl>
          </Card>
        </div>

        {/* Row 2: Main Valuation Chart & Compact Expandable Allocation Donut */}
        <div
          className={`grid grid-cols-1 gap-6 ${
            isAllocationExpanded ? "lg:items-start" : "lg:items-stretch"
          } lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]`}
        >
          <Card className="flex h-full flex-col p-4 sm:p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[18px] font-semibold tracking-[-0.015em] text-ink">
                Portfolio Value Over Time
              </h2>
              {snapshot.timeline.firstTransactionDate && (
                <span className="text-[12px] text-ink-3">
                  Since{" "}
                  <span className="font-mono text-ink-2">
                    {snapshot.timeline.firstTransactionDate}
                  </span>
                </span>
              )}
            </div>
            <PortfolioValueChart
              points={snapshot.timeline.points}
              currency={currency}
              excludedUnpricedSymbols={snapshot.timeline.excludedUnpricedSymbols}
              range={valueChartRange}
              onRangeChange={setValueChartRange}
            />
            <div className="mt-4">
              <MoneyInvestedChart
                points={snapshot.timeline.points}
                tradeEvents={snapshot.timeline.tradeEvents}
                currency={currency}
                range={valueChartRange}
              />
            </div>
          </Card>

          <Card className="flex h-full flex-col p-4 sm:p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[18px] font-semibold tracking-[-0.015em] text-ink">
                Asset Allocation
              </h2>
              <span className="num text-[12px] text-ink-2">
                {summary.openCount} open position
                {summary.openCount === 1 ? "" : "s"}
              </span>
            </div>
            <AllocationDonut
              allocations={snapshot.allocations}
              currency={currency}
              hasMissingSector={dataQuality.some(
                (d) => d.kind === "missing_sector",
              )}
              onExpandedChange={setIsAllocationExpanded}
            />
          </Card>
        </div>

        {/* Row 3: Benchmark Comparison */}
        <Card className="flex flex-col justify-between gap-4 p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border border-line bg-surface-2 text-accent">
                <ChartLine size={20} strokeWidth={1.75} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 className="text-[18px] font-semibold tracking-[-0.015em] text-ink">
                  Benchmark Comparison
                </h2>
                <p className="mt-0.5 text-[14px] text-ink-2">
                  Total return (dividends reinvested, {currency}) compared
                  against VOO (S&amp;P 500), ES3.SI (STI) &amp; ONEQ (NASDAQ).
                </p>
              </div>
            </div>
            <span className="rounded-[8px] border border-line bg-surface-2 px-2.5 py-1 text-[12px] font-medium text-ink-2">
              Total return · {currency}
            </span>
          </div>

          {/* Mobile stacked Benchmark Comparison cards */}
          <div className="divide-y divide-line overflow-hidden rounded-[12px] border border-line bg-surface-2 sm:hidden">
            <div className="p-3.5">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-[14px] font-semibold text-ink">
                    Your Portfolio
                  </p>
                  <p className="text-[12px] text-ink-2">
                    Time-weighted return
                  </p>
                </div>
                <span className="text-[12px] font-medium text-accent">
                  Baseline
                </span>
              </div>
              <div className="mt-2.5 grid grid-cols-2 gap-2 text-[12px]">
                <div>
                  <p className="text-[12px] text-ink-2">Annualized TWR</p>
                  <div className="num mt-0.5">
                    <GainBadge
                      percent={performance.annualizedTwrPercent}
                      size="sm"
                    />
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-[12px] text-ink-2">Cumulative TWR</p>
                  <div className="num mt-0.5">
                    <GainBadge
                      percent={performance.cumulativeTwrPercent}
                      size="sm"
                    />
                  </div>
                </div>
              </div>
            </div>

            {CORE_COMPARISON_BENCHMARKS.map((preset) => {
              const bench = snapshot.benchmarks[preset.symbol];
              const ok = bench && bench.status === "ok";
              const annRet = ok ? bench.annualizedReturnPercent : null;
              const cumRet = ok ? bench.cumulativeReturnPercent : null;
              const annSpread = ok
                ? computeReturnSpread(
                    performance.annualizedTwrPercent,
                    bench.annualizedReturnPercent,
                  )
                : null;

              return (
                <div key={preset.symbol} className="p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <Link
                      href="/benchmarks"
                      className="group flex min-w-0 items-baseline gap-1.5"
                    >
                      <span className="truncate text-[14px] font-medium text-ink transition-colors group-hover:text-accent">
                        {preset.label}
                      </span>
                      <span className="font-mono shrink-0 text-[12px] text-ink-2">
                        {formatSymbolForDisplay(preset.symbol)}
                      </span>
                    </Link>
                    <div className="num shrink-0">
                      {annSpread !== null ? (
                        <GainBadge percent={annSpread} size="sm" pill />
                      ) : (
                        <span className="text-[12px] text-ink-2">—</span>
                      )}
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-[12px]">
                    <div>
                      <p className="text-[12px] text-ink-2">Annualized</p>
                      <div className="num mt-0.5">
                        <GainBadge percent={annRet} size="sm" />
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-[12px] text-ink-2">Cumulative</p>
                      <div className="num mt-0.5">
                        <GainBadge percent={cumRet} size="sm" />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="hidden overflow-x-auto rounded-[12px] border border-line bg-surface-2 sm:block">
            <table className="w-full min-w-[460px] border-collapse text-left text-[14px]">
              <thead>
                <tr className="border-b border-line text-[12px] font-medium uppercase tracking-[0.04em] text-ink-2">
                  <th className="py-2.5 pl-4 pr-3">Benchmark</th>
                  <th className="px-3 py-2.5 text-right">Annualized TWR</th>
                  <th className="px-3 py-2.5 text-right">Cumulative TWR</th>
                  <th className="py-2.5 pl-3 pr-4 text-right">Ann. Spread</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                <tr className="bg-accent/6">
                  <td className="py-2.5 pl-4 pr-3">
                    <p className="font-semibold text-ink">Your Portfolio</p>
                    <p className="text-[12px] text-ink-2">
                      Time-weighted return
                    </p>
                  </td>
                  <td className="num px-3 py-2.5 text-right">
                    <GainBadge
                      percent={performance.annualizedTwrPercent}
                      size="sm"
                    />
                  </td>
                  <td className="num px-3 py-2.5 text-right">
                    <GainBadge
                      percent={performance.cumulativeTwrPercent}
                      size="sm"
                    />
                  </td>
                  <td className="py-2.5 pl-3 pr-4 text-right text-[12px] font-medium text-accent">
                    Baseline
                  </td>
                </tr>

                {CORE_COMPARISON_BENCHMARKS.map((preset) => {
                  const bench = snapshot.benchmarks[preset.symbol];
                  const ok = bench && bench.status === "ok";
                  const annRet = ok ? bench.annualizedReturnPercent : null;
                  const cumRet = ok ? bench.cumulativeReturnPercent : null;
                  const annSpread = ok
                    ? computeReturnSpread(
                        performance.annualizedTwrPercent,
                        bench.annualizedReturnPercent,
                      )
                    : null;

                  return (
                    <tr
                      key={preset.symbol}
                      className="transition-colors hover:bg-surface"
                    >
                      <td className="py-2.5 pl-4 pr-3">
                        <Link
                          href="/benchmarks"
                          className="group flex items-baseline gap-2"
                        >
                          <span className="font-medium text-ink transition-colors group-hover:text-accent">
                            {preset.label}
                          </span>
                          <span className="font-mono text-[12px] text-ink-2">
                            {formatSymbolForDisplay(preset.symbol)}
                          </span>
                        </Link>
                      </td>
                      <td className="num px-3 py-2.5 text-right">
                        <GainBadge percent={annRet} size="sm" />
                      </td>
                      <td className="num px-3 py-2.5 text-right">
                        <GainBadge percent={cumRet} size="sm" />
                      </td>
                      <td className="num py-2.5 pl-3 pr-4 text-right">
                        {annSpread !== null ? (
                          <GainBadge percent={annSpread} size="sm" pill />
                        ) : (
                          <span className="text-[12px] text-ink-2">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3.5">
            <p className="text-[12px] text-ink-3">
              {snapshot.timeline.firstTransactionDate ? (
                <>
                  Aligned from{" "}
                  <span className="font-mono">
                    {snapshot.timeline.firstTransactionDate}
                  </span>
                  {" · "}
                </>
              ) : (
                ""
              )}
              Curves, cash-flow simulation &amp; CAPM risk
            </p>
            <ButtonLink
              href="/benchmarks"
              variant="primary"
              size="sm"
              className="w-full sm:w-auto"
            >
              <ChartLine size={16} strokeWidth={1.75} aria-hidden="true" />
              <span>View Benchmark Detail</span>
              <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
            </ButtonLink>
          </div>
        </Card>

        {/* Row 4: Movers Today & All-Time Open Performers */}
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
          <MoverSummaryCard
            title="Today's Movers"
            headerRight={
              <Link
                href="/holdings"
                className="inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline"
              >
                Holdings
                <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
              </Link>
            }
            primaryTitle="Top Gainers"
            primaryEmpty="No priced holdings gaining today."
            primaryRows={snapshot.movers.topGainersToday}
            secondaryTitle="Top Losers"
            secondaryEmpty="No priced holdings declining today."
            secondaryRows={snapshot.movers.topLosersToday}
            mode="today"
            currency={currency}
          />

          <MoverSummaryCard
            title="All-Time Open Performers"
            headerRight={
              <span className="text-[12px] text-ink-3">Unrealized %</span>
            }
            primaryTitle="Best Performers"
            primaryEmpty="No open positions with positive unrealized return."
            primaryRows={snapshot.movers.topGainersAllTime}
            secondaryTitle="Laggards"
            secondaryEmpty="No open positions in unrealized loss."
            secondaryRows={snapshot.movers.topLosersAllTime}
            mode="all-time"
            currency={currency}
          />
        </div>

        {/* Row 5: Dividends & Risk alongside Collapsible Data Quality & Assumptions */}
        <div
          className={`grid grid-cols-1 gap-6 lg:grid-cols-2 ${
            unpricedOpenHoldings.length > 0 && !isQualityExpanded
              ? "lg:items-stretch"
              : "lg:items-start"
          }`}
        >
          <Card className="flex h-full flex-col justify-between gap-4 p-4 sm:p-5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-[18px] font-semibold tracking-[-0.015em] text-ink">
                Dividends &amp; Risk
              </h2>
              <Coins size={20} strokeWidth={1.75} className="text-ink-2" aria-hidden="true" />
            </div>

            <dl className="grid grid-cols-2 gap-3 rounded-[12px] border border-line bg-surface-2 p-3.5">
              <div>
                <dt className="text-[12px] text-ink-2">Lifetime Dividends</dt>
                <dd className="num mt-0.5 text-[14px] font-semibold text-ink">
                  {formatMoney(dividends.totalDividendsInBase, currency, {
                    locale,
                  })}
                </dd>
              </div>
              <div>
                <dt className="text-[12px] text-ink-2">Trailing 12M</dt>
                <dd className="num mt-0.5 text-[14px] font-semibold text-ink">
                  {formatMoney(dividends.trailing12MonthsInBase, currency, {
                    locale,
                  })}
                </dd>
              </div>
              <div className="col-span-2 border-t border-line pt-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-[12px] text-ink-2">Est. Annual Yield</dt>
                  <dd className="num text-[14px] font-semibold text-ink">
                    {dividends.projectedAnnualIncomeInBase !== null
                      ? formatMoney(
                          dividends.projectedAnnualIncomeInBase,
                          currency,
                          { locale },
                        )
                      : "Unavailable"}
                  </dd>
                </div>
                <p className="mt-0.5 text-[12px] text-ink-3">
                  {dividends.holdingsWithYieldCount}/
                  {dividends.openHoldingsCount} open holdings reporting yield
                </p>
              </div>
            </dl>

            <div className="grid grid-cols-3 gap-2.5 text-center">
              <div className="min-w-0 rounded-[12px] border border-line bg-surface-2 px-2 py-2">
                <p className="text-[12px] text-ink-2">Max Drawdown</p>
                <p className="num mt-0.5 text-[13px] font-semibold text-loss">
                  {performance.drawdown.maxDrawdownPercent
                    ? formatPercent(performance.drawdown.maxDrawdownPercent)
                    : "—"}
                </p>
              </div>
              <div className="min-w-0 rounded-[12px] border border-line bg-surface-2 px-2 py-2">
                <p className="text-[12px] text-ink-2">Volatility</p>
                <p className="num mt-0.5 text-[13px] font-semibold text-ink">
                  {performance.volatilityPercent
                    ? `${performance.volatilityPercent}%`
                    : "—"}
                </p>
              </div>
              <div className="min-w-0 rounded-[12px] border border-line bg-surface-2 px-2 py-2">
                <p className="text-[12px] text-ink-2">Sharpe</p>
                <p className="num mt-0.5 text-[13px] font-semibold text-ink">
                  {performance.sharpeRatio ?? "—"}
                </p>
              </div>
            </div>
          </Card>

          <div className="flex h-full flex-col gap-4">
            <Card className="p-4 sm:p-5">
              <button
                type="button"
                onClick={() => setIsQualityExpanded((prev) => !prev)}
                aria-expanded={isQualityExpanded}
                className="flex w-full items-start justify-between gap-3 rounded-[10px] text-left"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-[18px] font-semibold tracking-[-0.015em] text-ink">
                      Data Quality &amp; Assumptions
                    </h2>
                    {dataQuality.length === 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-[8px] border border-line bg-surface-2 px-2 py-0.5 text-[12px] font-medium text-ink-2">
                        <CheckCircle2 size={14} strokeWidth={1.75} className="text-accent" aria-hidden="true" />
                        Complete
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-[8px] border border-line bg-surface-2 px-2 py-0.5 text-[12px] font-medium text-ink-2">
                        {dataQuality.some((d) => d.severity === "warning") ? (
                          <AlertTriangle
                            size={14}
                            strokeWidth={1.75}
                            className="text-ink-2"
                            aria-hidden="true"
                          />
                        ) : (
                          <Info
                            size={14}
                            strokeWidth={1.75}
                            className="text-accent"
                            aria-hidden="true"
                          />
                        )}
                        {dataQuality.length} note
                        {dataQuality.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[12px] text-ink-3">
                    FIFO · Dividends as{" "}
                    {snapshot.scope.dividendMode === "shares"
                      ? "Reinvested Shares"
                      : "Cash Payouts"}
                    {!isQualityExpanded && dataQuality.length > 0
                      ? " · Tap to review pricing & FX coverage notes"
                      : ""}
                  </p>
                </div>

                <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-line bg-surface-2 text-ink-2 transition-colors hover:text-ink">
                  <ChevronDown
                    size={16}
                    strokeWidth={1.75}
                    aria-hidden="true"
                    className={`transition-transform duration-150 ${
                      isQualityExpanded ? "rotate-180" : ""
                    }`}
                  />
                </span>
              </button>

              <AnimatePresence initial={false}>
                {isQualityExpanded && (
                  <motion.div
                    key="data-quality-panel"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{
                      opacity: 1,
                      height: "auto",
                      transition: { ...springSmooth, opacity: fadeQuick },
                    }}
                    exit={{
                      opacity: 0,
                      height: 0,
                      transition: { ...fadeQuick, opacity: { duration: 0.1 } },
                    }}
                    className="overflow-hidden"
                  >
                    <div className="mt-3.5 border-t border-line pt-3.5">
                      <p className="text-[12px] text-ink-2">
                        Transparent notes on excluded unpriced symbols, historical
                        FX coverage, and cost-basis edge cases.
                      </p>

                      {dataQuality.length === 0 ? (
                        <div className="mt-3 flex items-center gap-2.5 rounded-[12px] border border-line bg-surface-2 px-3.5 py-2.5 text-[13px] text-ink-2">
                          <CheckCircle2
                            size={16}
                            strokeWidth={1.75}
                            className="shrink-0 text-accent"
                            aria-hidden="true"
                          />
                          <span>
                            All open positions have live/cached prices and
                            complete FX history.
                          </span>
                        </div>
                      ) : (
                        <ul className="mt-3 divide-y divide-line">
                          {dataQuality.map((item, idx) => (
                            <li
                              key={`${item.kind}-${item.symbol ?? idx}`}
                              className="flex flex-wrap items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                            >
                              <div className="flex min-w-0 items-start gap-2.5">
                                {item.severity === "warning" ? (
                                  <AlertTriangle
                                    size={16}
                                    strokeWidth={1.75}
                                    className="mt-0.5 shrink-0 text-ink-2"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <Info
                                    size={16}
                                    strokeWidth={1.75}
                                    className="mt-0.5 shrink-0 text-accent"
                                    aria-hidden="true"
                                  />
                                )}
                                <div className="min-w-0">
                                  <p className="text-[13px] font-medium text-ink">
                                    {item.title}
                                  </p>
                                  <p className="text-[12px] text-ink-2">
                                    {item.description}
                                  </p>
                                </div>
                              </div>
                              {item.actionHref && item.actionLabel && (
                                <Link
                                  href={item.actionHref}
                                  className="shrink-0 rounded-[8px] border border-line bg-surface-2 px-3 py-1 text-[12px] font-medium text-accent transition-colors hover:border-accent/40"
                                >
                                  {item.actionLabel}
                                </Link>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </Card>

            {unpricedOpenHoldings.length > 0 && (
              <Card className="flex flex-1 flex-col justify-between gap-3 p-4 sm:p-5">
                <div className="flex items-center justify-between gap-2.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <h2 className="truncate text-[18px] font-semibold tracking-[-0.015em] text-ink">
                      Prices Not Found
                    </h2>
                    <span className="num inline-flex shrink-0 items-center rounded-[8px] border border-line bg-surface-2 px-2 py-0.5 text-[12px] font-semibold text-ink-2">
                      {unpricedOpenHoldings.length}
                    </span>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {retryableNotFoundSymbols.length > 0 && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="xs"
                        disabled={livePoll.isRetrying}
                        onClick={() => {
                          void livePoll
                            .retrySymbols(retryableNotFoundSymbols)
                            .then((res) => {
                              if (
                                res &&
                                Object.values(res).some(
                                  (q) => q.price !== null,
                                )
                              ) {
                                void loadAnalyticsScope({
                                  portfolioId: selectedPortfolioId,
                                  currency: selectedCurrency,
                                  forceRefresh: true,
                                });
                              }
                            });
                        }}
                      >
                        <RefreshCw
                          size={14}
                          strokeWidth={1.75}
                          className={
                            livePoll.isRetrying ? "animate-spin" : undefined
                          }
                          aria-hidden="true"
                        />
                        <span>
                          {livePoll.isRetrying ? "Checking…" : "Retry"}
                        </span>
                      </Button>
                    )}
                    <ButtonLink
                      href="/holdings#not-found"
                      variant="ghost"
                      size="xs"
                    >
                      <span>Manage</span>
                      <ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" />
                    </ButtonLink>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {visibleUnpriced.map((item) => {
                    const isCrypto = item.assetType === "crypto";
                    return (
                      <Link
                        key={item.key}
                        href={`/holdings/${encodeURIComponent(item.symbol)}`}
                        title={
                          isCrypto
                            ? `${formatSymbolForDisplay(item.symbol)} · Crypto pricing disabled — tap to set manual price`
                            : `${formatSymbolForDisplay(item.symbol)} · Not found on providers — tap to retry or set manual price`
                        }
                        className="inline-flex h-7 items-center gap-1.5 rounded-[8px] border border-line bg-surface-2 px-2.5 text-[12px] transition-colors hover:border-accent/50"
                      >
                        <span
                          aria-hidden="true"
                          className={`h-1.5 w-1.5 rounded-full ${
                            isCrypto ? "bg-ink-3" : "bg-accent"
                          }`}
                        />
                        <span
                          className={`font-mono font-medium ${
                            isCrypto ? "text-ink-2" : "text-ink"
                          }`}
                        >
                          {formatSymbolForDisplay(item.symbol)}
                        </span>
                      </Link>
                    );
                  })}
                  {extraUnpricedCount > 0 && (
                    <Link
                      href="/holdings#not-found"
                      className="num inline-flex h-7 items-center rounded-[8px] border border-line bg-surface-2 px-2.5 text-[12px] font-medium text-ink-2 transition-colors hover:text-ink"
                    >
                      +{extraUnpricedCount} more
                    </Link>
                  )}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[12px] text-ink-3">
                  <div className="flex flex-wrap items-center gap-3">
                    {providerNotFoundCount > 0 && (
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          aria-hidden="true"
                          className="h-1.5 w-1.5 rounded-full bg-accent"
                        />
                        <span>Not found ({providerNotFoundCount})</span>
                      </span>
                    )}
                    {cryptoNotFoundCount > 0 && (
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          aria-hidden="true"
                          className="h-1.5 w-1.5 rounded-full bg-ink-3"
                        />
                        <span>Crypto ({cryptoNotFoundCount})</span>
                      </span>
                    )}
                  </div>
                  <span>Skipped from live polling</span>
                </div>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
