"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChartLine,
  Check,
  ChevronDown,
  FileUp,
  Plus,
  Search,
  X,
} from "lucide-react";
import { MetricTooltip } from "@/components/analytics/metric-tooltip";
import {
  type BenchmarkChartViewMode,
  BenchmarkComparisonChart,
} from "@/components/charts/benchmark-comparison-chart";
import { DrawdownChart } from "@/components/charts/drawdown-chart";
import { ButtonLink } from "@/components/ui/button-link";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { GainBadge } from "@/components/ui/gain-badge";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import {
  computeReturnSpread,
  PRESET_BENCHMARKS,
  resolveBenchmarkLabel,
} from "@/lib/benchmarks/summary";
import { SERIES_PALETTE } from "@/lib/charts/theme";
import type { PeriodReturnKey } from "@/lib/finance";
import { formatPercent } from "@/lib/format";
import type { SymbolSearchMatch } from "@/lib/market-data/search";
import { fadeQuick } from "@/lib/motion";
import type {
  BenchmarkSeriesData,
  PortfolioAnalyticsSnapshot,
} from "@/lib/services/analytics";
import { searchStocksClient } from "@/lib/transactions/client-market-api";
import { formatSymbolForDisplay } from "@/lib/transactions/form-logic";

interface BenchmarksViewProps {
  initialSnapshot: PortfolioAnalyticsSnapshot;
}

type ViewTab = BenchmarkChartViewMode | "period-table";

const CURRENCY_OPTIONS: readonly SegmentedOption<"SGD" | "USD">[] = [
  { value: "SGD", label: "SGD" },
  { value: "USD", label: "USD" },
];

const VIEW_TAB_OPTIONS: readonly SegmentedOption<ViewTab>[] = [
  { value: "rebased", label: "Rebased to 100" },
  { value: "same-cash-flows", label: "Same cash flows" },
  { value: "period-table", label: "Period returns" },
];

const PERIOD_COLUMNS: readonly PeriodReturnKey[] = [
  "1D",
  "1W",
  "1M",
  "3M",
  "6M",
  "YTD",
  "1Y",
  "3Y",
  "5Y",
  "ALL",
];

function periodMetricCellClass(isLast: boolean): string {
  return isLast
    ? "num whitespace-nowrap py-3 pl-1 pr-4 text-right xl:pl-1.5"
    : "num whitespace-nowrap px-1 py-3 text-right xl:px-1.5";
}

/**
 * Benchmarks & Portfolio Risk Analytics view (`/benchmarks`).
 */
export function BenchmarksView({ initialSnapshot }: BenchmarksViewProps) {
  const [snapshot, setSnapshot] =
    useState<PortfolioAnalyticsSnapshot>(initialSnapshot);
  const [selectedPortfolioId, setSelectedPortfolioId] = useState<string>(
    initialSnapshot.scope.portfolioFilterId,
  );
  const [selectedCurrency, setSelectedCurrency] = useState<"SGD" | "USD">(
    initialSnapshot.scope.currency,
  );
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>(() => {
    const def = initialSnapshot.scope.defaultBenchmark.toUpperCase();
    const initial = ["^GSPC", "^STI", "^IXIC"];
    if (!initial.includes(def)) {
      initial.unshift(def);
    }
    return initial;
  });
  const [customSymbols, setCustomSymbols] = useState<string[]>(() => {
    const def = initialSnapshot.scope.defaultBenchmark.toUpperCase();
    const presetSet = new Set(PRESET_BENCHMARKS.map((p) => p.symbol));
    return presetSet.has(def) ? [] : [def];
  });
  const [primarySymbol, setPrimarySymbol] = useState<string>(
    initialSnapshot.scope.defaultBenchmark.toUpperCase() || "^GSPC",
  );
  const [viewTab, setViewTab] = useState<ViewTab>("rebased");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const snapshotCacheRef = useRef<Map<string, PortfolioAnalyticsSnapshot>>(
    new Map(),
  );

  useEffect(() => {
    const presetSymbols = PRESET_BENCHMARKS.map((p) => p.symbol);
    const loadedSymbols = Object.keys(initialSnapshot.benchmarks);
    const keySymbols = [
      ...new Set([...presetSymbols, ...loadedSymbols]),
    ]
      .sort()
      .join(",");
    snapshotCacheRef.current.set(
      `${initialSnapshot.scope.portfolioFilterId}::${initialSnapshot.scope.currency}::${keySymbols}`,
      initialSnapshot,
    );
  }, [initialSnapshot]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Custom benchmark ticker search
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SymbolSearchMatch[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (trimmed.length < 1) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setIsSearching(true);
      void searchStocksClient(trimmed, { signal: controller.signal })
        .then((matches) => {
          setSearchResults(matches.slice(0, 6));
        })
        .catch(() => {
          setSearchResults([]);
        })
        .finally(() => {
          setIsSearching(false);
        });
    }, 220);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [searchQuery]);

  async function reloadAnalytics(next: {
    portfolioId: string;
    currency: "SGD" | "USD";
    benchmarksList: string[];
    cacheOnly?: boolean;
  }) {
    const normalizedBenchmarks = [...new Set(next.benchmarksList)].sort();
    const cacheKey = `${next.portfolioId}::${next.currency}::${normalizedBenchmarks.join(",")}`;
    const cached = snapshotCacheRef.current.get(cacheKey);
    const seq = ++requestSeqRef.current;
    abortRef.current?.abort();

    if (cached) {
      setSelectedPortfolioId(cached.scope.portfolioFilterId);
      setSelectedCurrency(cached.scope.currency);
      setSnapshot(cached);
      setIsLoading(false);
      setErrorMsg(null);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    // Move scope controls immediately so thumb glides in 0ms while data loads.
    setSelectedPortfolioId(next.portfolioId);
    setSelectedCurrency(next.currency);
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const qs = new URLSearchParams({
        portfolioId: next.portfolioId,
        currency: next.currency,
        benchmarks: next.benchmarksList.join(","),
        includeBenchmarks: "true",
        includeFundamentals: "false",
      });
      if (next.cacheOnly) {
        qs.set("cacheOnly", "true");
      }
      const res = await fetch(`/api/analytics?${qs.toString()}`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Unable to load benchmark comparison.");
      }
      const data = (await res.json()) as PortfolioAnalyticsSnapshot;
      snapshotCacheRef.current.set(cacheKey, data);
      if (seq === requestSeqRef.current) {
        setSnapshot(data);
        setSelectedPortfolioId(data.scope.portfolioFilterId);
        setSelectedCurrency(data.scope.currency);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      if (seq === requestSeqRef.current) {
        setSelectedPortfolioId(snapshot.scope.portfolioFilterId);
        setSelectedCurrency(snapshot.scope.currency);
        setErrorMsg(
          error instanceof Error
            ? error.message
            : "Unable to load benchmark analytics.",
        );
      }
    } finally {
      if (seq === requestSeqRef.current) {
        setIsLoading(false);
      }
    }
  }

  function handleToggleBenchmark(symbol: string) {
    const next = selectedSymbols.includes(symbol)
      ? selectedSymbols.filter((s) => s !== symbol)
      : [...selectedSymbols, symbol];

    if (next.length === 0) {
      return;
    }
    setSelectedSymbols(next);
    if (!next.includes(primarySymbol)) {
      setPrimarySymbol(next[0]);
    }
    if (!snapshot.benchmarks[symbol]) {
      const allTracked = [
        ...new Set([
          ...PRESET_BENCHMARKS.map((p) => p.symbol),
          ...customSymbols,
          ...next,
        ]),
      ];
      void reloadAnalytics({
        portfolioId: selectedPortfolioId,
        currency: selectedCurrency,
        benchmarksList: allTracked,
      });
    }
  }

  function handleAddCustomBenchmark(rawSymbol: string) {
    const clean = rawSymbol.trim().toUpperCase();
    if (!clean) return;

    setSearchQuery("");
    setSearchResults([]);

    const presetSet = new Set(PRESET_BENCHMARKS.map((p) => p.symbol));
    const nextCustoms =
      !presetSet.has(clean) && !customSymbols.includes(clean)
        ? [...customSymbols, clean]
        : customSymbols;
    const nextSelected = selectedSymbols.includes(clean)
      ? selectedSymbols
      : [...selectedSymbols, clean];

    setCustomSymbols(nextCustoms);
    setSelectedSymbols(nextSelected);
    setPrimarySymbol(clean);

    if (!snapshot.benchmarks[clean]) {
      const allTracked = [
        ...new Set([
          ...PRESET_BENCHMARKS.map((p) => p.symbol),
          ...nextCustoms,
          ...nextSelected,
        ]),
      ];
      void reloadAnalytics({
        portfolioId: selectedPortfolioId,
        currency: selectedCurrency,
        benchmarksList: allTracked,
      });
    }
  }

  function handleRemoveCustom(symbol: string) {
    const nextCustoms = customSymbols.filter((s) => s !== symbol);
    const nextSelected = selectedSymbols.filter((s) => s !== symbol);
    if (nextSelected.length === 0) {
      nextSelected.push("^GSPC");
    }
    setCustomSymbols(nextCustoms);
    setSelectedSymbols(nextSelected);
    if (primarySymbol === symbol) {
      setPrimarySymbol(nextSelected[0]);
    }
  }

  if (snapshot.accountHasNoTransactions || snapshot.isEmpty) {
    return (
      <EmptyState
        icon={ChartLine}
        title="Nothing to compare yet"
        description={
          snapshot.accountHasNoTransactions
            ? "Benchmark comparison requires recorded transactions and market price history. Import your CSV or add your first trade first."
            : `No transactions exist in ${snapshot.scope.portfolioName} yet.`
        }
        actions={
          <>
            <ButtonLink href="/import-export">
              <FileUp size={18} strokeWidth={1.75} aria-hidden="true" />
              Import my CSV
            </ButtonLink>
            <ButtonLink href="/transactions" variant="secondary">
              <Plus size={18} strokeWidth={1.75} aria-hidden="true" />
              Add transaction
            </ButtonLink>
          </>
        }
      />
    );
  }

  const currency = snapshot.scope.currency;
  const activeBenchmarkObjects: BenchmarkSeriesData[] = selectedSymbols
    .map((sym) => snapshot.benchmarks[sym])
    .filter((b): b is BenchmarkSeriesData => Boolean(b));

  const primaryBenchmark =
    snapshot.benchmarks[primarySymbol] ?? activeBenchmarkObjects[0] ?? null;

  const { performance } = snapshot;

  return (
    <div className="space-y-6">
      {/* Scope + Currency Alignment Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <label className="sr-only" htmlFor="benchmarks-portfolio-filter">
            Portfolio scope
          </label>
          <div className="relative inline-flex items-center">
            <select
              id="benchmarks-portfolio-filter"
              value={selectedPortfolioId}
              onChange={(e) => {
                const allTracked = [
                  ...new Set([
                    ...PRESET_BENCHMARKS.map((p) => p.symbol),
                    ...customSymbols,
                    ...selectedSymbols,
                  ]),
                ];
                void reloadAnalytics({
                  portfolioId: e.target.value,
                  currency: selectedCurrency,
                  benchmarksList: allTracked,
                  cacheOnly: e.target.value === selectedPortfolioId,
                });
              }}
              className="field-input h-9.5 appearance-none bg-surface pr-8 text-[13.5px] font-medium"
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
              className="pointer-events-none absolute right-2.5 text-ink-2"
              aria-hidden="true"
            />
          </div>

          <SegmentedControl
            ariaLabel="Comparison currency"
            options={CURRENCY_OPTIONS}
            value={selectedCurrency}
            layoutId="benchmarks-currency-seg"
            onChange={(nextCurrency) => {
              if (nextCurrency === selectedCurrency) return;
              const allTracked = [
                ...new Set([
                  ...PRESET_BENCHMARKS.map((p) => p.symbol),
                  ...customSymbols,
                  ...selectedSymbols,
                ]),
              ];
              void reloadAnalytics({
                portfolioId: selectedPortfolioId,
                currency: nextCurrency,
                benchmarksList: allTracked,
                cacheOnly: true,
              });
            }}
          />
        </div>

        <p className="text-[12.5px] text-ink-2">
          Compared in <strong className="font-semibold text-ink">{currency}</strong> · indices FX-converted daily
        </p>
      </div>

      {errorMsg && (
        <div
          role="alert"
          className="rounded-[10px] border border-loss/30 bg-loss/10 px-4 py-2.5 text-[13px] text-loss"
        >
          {errorMsg}
        </div>
      )}

      <div
        className={`space-y-6 transition-opacity duration-200 ${
          isLoading ? "opacity-65" : "opacity-100"
        }`}
      >
        {/* Comprehensive Risk & CAPM Metrics Grid */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card className="p-5">
            <div className="flex items-center gap-1.5">
              <p className="text-[12.5px] font-medium text-ink-2">
                Time-Weighted Returns
              </p>
              <MetricTooltip
                label="Annualized & Cumulative TWR"
                explanation="Measures pure investment skill across time without distortion from when you deposited or withdrew cash."
              />
            </div>
            <dl className="mt-2.5 divide-y divide-line">
              <div className="flex items-center justify-between gap-2 pb-1.5">
                <dt className="text-[12px] font-medium text-ink-2">Annualized</dt>
                <dd>
                  <GainBadge
                    percent={performance.annualizedTwrPercent}
                    size="lg"
                  />
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2 pt-1.5">
                <dt className="text-[12px] font-medium text-ink-2">Cumulative</dt>
                <dd>
                  <GainBadge
                    percent={performance.cumulativeTwrPercent}
                    size="lg"
                  />
                </dd>
              </div>
            </dl>
          </Card>

          <Card className="p-5">
            <div className="flex items-center gap-1.5">
              <p className="text-[12.5px] font-medium text-ink-2">
                Personal Return (XIRR)
              </p>
              <MetricTooltip
                label="XIRR"
                explanation="Your exact annualized money-weighted return accounting for every deposit, withdrawal, and cash dividend date."
              />
            </div>
            <div className="mt-2">
              <GainBadge percent={performance.xirrPercent} size="lg" />
            </div>
            <p className="num mt-2.5 text-[12px] text-ink-2">
              Closed trades:{" "}
              <span className="font-medium text-ink">
                {performance.winningTradeCount}/{performance.closedTradeCount}
                {performance.winRatePercent
                  ? ` (${performance.winRatePercent}%)`
                  : ""}
              </span>
            </p>
          </Card>

          <Card className="p-5">
            <div className="flex items-center gap-1.5">
              <p className="text-[12.5px] font-medium text-ink-2">
                Volatility &amp; Sharpe Ratio
              </p>
              <MetricTooltip
                label="Sharpe Ratio"
                explanation="Excess annualized return over the risk-free rate divided by annualized return volatility (higher = better risk-adjusted return)."
              />
            </div>
            <p className="num mt-1.5 text-[22px] font-semibold tracking-tight text-ink">
              {performance.sharpeRatio ?? "—"}
            </p>
            <p className="num mt-1.5 text-[12px] text-ink-2">
              Ann. vol{" "}
              <span className="font-medium text-ink">
                {performance.volatilityPercent
                  ? `${performance.volatilityPercent}%`
                  : "—"}
              </span>
              {" · "}
              Rf {snapshot.scope.riskFreeRatePercent}%
            </p>
          </Card>

          <Card className="p-5">
            <div className="flex items-center gap-1.5">
              <p className="text-[12.5px] font-medium text-ink-2">
                vs{" "}
                <span className="font-mono">
                  {primaryBenchmark?.displaySymbol ?? "Benchmark"}
                </span>
              </p>
              <MetricTooltip
                label="Beta, Alpha & Correlation"
                explanation="Beta measures market sensitivity (1.0 moves with the index). Alpha is excess annualized return after adjusting for Beta."
              />
            </div>
            <p className="num mt-1.5 text-[22px] font-semibold tracking-tight text-ink">
              {primaryBenchmark?.betaVsPortfolio !== null &&
              primaryBenchmark?.betaVsPortfolio !== undefined
                ? `β ${primaryBenchmark.betaVsPortfolio}`
                : "—"}
            </p>
            <p className="num mt-1.5 text-[12px] text-ink-2">
              α{" "}
              <span className="font-medium text-ink">
                {primaryBenchmark?.alphaPercentVsPortfolio
                  ? formatPercent(primaryBenchmark.alphaPercentVsPortfolio, {
                      signed: true,
                    })
                  : "—"}
              </span>
              {" · "}r{" "}
              <span className="font-medium text-ink">
                {primaryBenchmark?.correlationVsPortfolio ?? "—"}
              </span>
            </p>
          </Card>
        </div>

        {/* Benchmark Selector Buttons + Custom Search */}
        <Card className="p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {PRESET_BENCHMARKS.map((preset) => {
              const active = selectedSymbols.includes(preset.symbol);
              const activeIndex = selectedSymbols.indexOf(preset.symbol);
              const color =
                active && activeIndex >= 0
                  ? SERIES_PALETTE[
                      (activeIndex + 1) % (SERIES_PALETTE.length - 1)
                    ]
                  : undefined;

              return (
                <button
                  key={preset.symbol}
                  type="button"
                  aria-pressed={active}
                  onClick={() => handleToggleBenchmark(preset.symbol)}
                  className={`inline-flex h-8.5 cursor-pointer items-center gap-2 rounded-[10px] border px-3 text-[13px] font-medium transition-colors ${
                    active
                      ? "border-accent/50 bg-accent/12 text-ink"
                      : "border-line bg-surface-2 text-ink-2 hover:text-ink"
                  }`}
                >
                  {active ? (
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                  ) : (
                    <Check className="h-3.5 w-3.5 opacity-45" aria-hidden="true" />
                  )}
                  <span>{preset.label}</span>
                  <span className="font-mono text-[11px] text-ink-3">
                    {formatSymbolForDisplay(preset.symbol)}
                  </span>
                </button>
              );
            })}

            {customSymbols.map((sym) => {
              const active = selectedSymbols.includes(sym);
              const activeIndex = selectedSymbols.indexOf(sym);
              const color =
                active && activeIndex >= 0
                  ? SERIES_PALETTE[
                      (activeIndex + 1) % (SERIES_PALETTE.length - 1)
                    ]
                  : undefined;
              return (
                <span
                  key={sym}
                  className={`inline-flex h-8.5 items-center gap-1 rounded-[10px] border pl-3 pr-1.5 text-[13px] font-medium ${
                    active
                      ? "border-accent/50 bg-accent/12 text-ink"
                      : "border-line bg-surface-2 text-ink-2"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => handleToggleBenchmark(sym)}
                    className="inline-flex cursor-pointer items-center gap-1.5"
                  >
                    {active && (
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: color }}
                      />
                    )}
                    <span className="font-mono">
                      {formatSymbolForDisplay(sym)}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${formatSymbolForDisplay(sym)}`}
                    onClick={() => handleRemoveCustom(sym)}
                    className="cursor-pointer rounded-[6px] p-0.5 text-ink-2 hover:bg-surface hover:text-ink"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </span>
              );
            })}
          </div>

          {/* Search box */}
          <div className="relative w-full sm:w-72">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-2"
              aria-hidden="true"
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                const nextVal = e.target.value;
                setSearchQuery(nextVal);
                if (!nextVal.trim()) {
                  setSearchResults([]);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && searchQuery.trim()) {
                  e.preventDefault();
                  const topMatch = searchResults[0]?.symbol ?? searchQuery.trim();
                  handleAddCustomBenchmark(topMatch);
                }
              }}
              placeholder="Add ETF or ticker (SPY, ES3.SI)…"
              aria-label="Add custom benchmark ticker"
              className="field-input h-9.5 pl-9 pr-3 text-[13px]"
            />

            {searchQuery.trim().length > 0 &&
              (searchResults.length > 0 || isSearching) && (
                <div className="absolute right-0 top-full z-30 mt-1.5 w-full overflow-hidden rounded-[12px] border border-line bg-surface-2 shadow-raised">
                  {isSearching && searchResults.length === 0 ? (
                    <div className="divide-y divide-line" aria-busy="true">
                      {Array.from({ length: 2 }).map((_, idx) => (
                        <div key={idx} className="space-y-1.5 px-3.5 py-2.5">
                          <Skeleton className="h-3.5 w-20" />
                          <Skeleton className="h-3 w-36" />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <ul className="divide-y divide-line">
                      {searchResults.map((match) => (
                        <li key={match.symbol}>
                          <button
                            type="button"
                            onClick={() =>
                              handleAddCustomBenchmark(match.symbol)
                            }
                            className="flex w-full cursor-pointer items-center justify-between gap-2 px-3.5 py-2 text-left text-[12.5px] hover:bg-surface"
                          >
                            <div className="min-w-0">
                              <p className="font-mono font-semibold text-ink">
                                {formatSymbolForDisplay(match.symbol)}
                              </p>
                              <p className="truncate text-[12px] text-ink-2">
                                {match.name}
                              </p>
                            </div>
                            <span className="shrink-0 text-[12px] font-medium text-accent">
                              Add
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
          </div>
        </div>
      </Card>

      {/* Main Comparison Card: Rebased to 100 / Same Cash Flows / Period Returns */}
      <Card className="p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SegmentedControl
            ariaLabel="Benchmark comparison view mode"
            options={VIEW_TAB_OPTIONS}
            value={viewTab}
            onChange={setViewTab}
            layoutId="benchmarks-view-tab-seg"
          />

          {activeBenchmarkObjects.length > 0 && (
            <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 text-[12.5px]">
              <label htmlFor="primary-benchmark-select" className="text-ink-2">
                Focus index:
              </label>
              <div className="relative inline-flex min-w-0 max-w-full items-center">
                <select
                  id="primary-benchmark-select"
                  value={primaryBenchmark?.symbol ?? primarySymbol}
                  onChange={(e) => setPrimarySymbol(e.target.value)}
                  className="field-input h-8.5! max-w-full min-w-0 appearance-none bg-surface-2 pr-7! font-medium sm:text-[12.5px]"
                >
                  {activeBenchmarkObjects.map((b) => (
                    <option key={b.symbol} value={b.symbol}>
                      {b.name} ({b.displaySymbol})
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={14}
                  className="pointer-events-none absolute right-2 text-ink-2"
                  aria-hidden="true"
                />
              </div>
            </div>
          )}
        </div>

        <AnimatePresence mode="wait" initial={false}>
          {viewTab === "period-table" ? (
            <motion.div
              key="period-table"
              initial={{ opacity: 0, y: 2 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -2 }}
              transition={fadeQuick}
              className="overflow-x-auto rounded-[12px] border border-line bg-surface-2"
            >
              <table className="w-full border-collapse text-left text-[13px]">
                <thead>
                  <tr className="border-b border-line whitespace-nowrap text-[12px] font-medium text-ink-2">
                    <th className="py-2.5 pl-4 pr-2">Series ({currency})</th>
                    <th className="px-1 py-2.5 text-right xl:px-1.5">Ann. TWR</th>
                    {PERIOD_COLUMNS.map((col, idx) => (
                      <th
                        key={col}
                        title={
                          col === "ALL"
                            ? "Cumulative return aligned to your portfolio start date"
                            : undefined
                        }
                        className={
                          idx === PERIOD_COLUMNS.length - 1
                            ? "py-2.5 pl-1 pr-4 text-right xl:pl-1.5"
                            : "px-1 py-2.5 text-right xl:px-1.5"
                        }
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  <tr className="bg-accent/8">
                    <td className="whitespace-nowrap py-3 pl-4 pr-2">
                      <div className="flex items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full bg-accent"
                          aria-hidden="true"
                        />
                        <span className="font-semibold text-ink">
                          Your Portfolio
                        </span>
                        <span className="font-mono text-[11px] text-ink-3">
                          TWR
                        </span>
                      </div>
                    </td>
                    <td className={periodMetricCellClass(false)}>
                      <GainBadge percent={performance.annualizedTwrPercent} size="xs" />
                    </td>
                    {PERIOD_COLUMNS.map((col, idx) => {
                      const val = performance.periodReturns[col];
                      return (
                        <td
                          key={col}
                          className={periodMetricCellClass(
                            idx === PERIOD_COLUMNS.length - 1,
                          )}
                        >
                          {val !== null ? (
                            <GainBadge percent={val} size="xs" />
                          ) : (
                            <span className="text-[11.5px] text-ink-3">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                  {activeBenchmarkObjects.map((bench, index) => {
                    const color =
                      SERIES_PALETTE[(index + 1) % (SERIES_PALETTE.length - 1)];
                    return (
                      <tr
                        key={bench.symbol}
                        className="transition-colors hover:bg-surface"
                      >
                        <td className="max-w-[175px] whitespace-nowrap py-3 pl-4 pr-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: color }}
                              aria-hidden="true"
                            />
                            <span className="truncate font-medium text-ink">
                              {resolveBenchmarkLabel(bench.symbol, bench.name)}
                            </span>
                            <span className="shrink-0 font-mono text-[11px] text-ink-3">
                              {bench.displaySymbol}
                            </span>
                          </div>
                        </td>
                        <td className={periodMetricCellClass(false)}>
                          <GainBadge
                            percent={
                              bench.status === "ok"
                                ? bench.annualizedReturnPercent
                                : null
                            }
                            size="xs"
                          />
                        </td>
                        {PERIOD_COLUMNS.map((col, idx) => {
                          const val = bench.periodReturns[col];
                          return (
                            <td
                              key={col}
                              className={periodMetricCellClass(
                                idx === PERIOD_COLUMNS.length - 1,
                              )}
                            >
                              {val !== null ? (
                                <GainBadge percent={val} size="xs" />
                              ) : (
                                <span className="text-[11.5px] text-ink-3">—</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </motion.div>
          ) : (
            <motion.div
              key="benchmark-chart"
              initial={{ opacity: 0, y: 2 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -2 }}
              transition={fadeQuick}
            >
              <BenchmarkComparisonChart
                mode={viewTab}
                currency={currency}
                portfolioSeries={snapshot.timeline.points}
                selectedBenchmarks={activeBenchmarkObjects}
                primaryBenchmark={primaryBenchmark}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </Card>

      {/* TWR Summary & Risk/Spread Detail Table */}
      <Card className="p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-1.5">
              <h2 className="text-[18px] font-semibold tracking-tight text-ink">
                TWR Breakdown vs Benchmarks
              </h2>
              <MetricTooltip
                label="Aligned TWR & Benchmark Spreads"
                explanation="Annualized TWR (CAGR) and Cumulative TWR are computed over the exact same active date window and aligned in your selected currency. Positive spread means your portfolio outperformed the index."
              />
            </div>
            <p className="mt-0.5 text-[12.5px] text-ink-2">
              {snapshot.timeline.firstTransactionDate ? (
                <>
                  Aligned from{" "}
                  <span className="font-mono">
                    {snapshot.timeline.firstTransactionDate}
                  </span>{" "}
                  through today
                </>
              ) : (
                "Aligned across full active history"
              )}{" "}
              · Annualized &amp; Cumulative TWR with excess spreads, volatility,
              drawdown &amp; CAPM risk in {currency}.
            </p>
          </div>
          <span className="text-[12px] font-medium text-ink-2">
            Aligned in {currency}
          </span>
        </div>

        <div className="overflow-x-auto rounded-[12px] border border-line bg-surface-2">
          <table className="w-full min-w-[780px] border-collapse text-left text-[13.5px]">
            <thead>
              <tr className="border-b border-line text-[12px] font-medium text-ink-2">
                <th className="py-2.5 pl-4 pr-3">Series</th>
                <th className="px-3 py-2.5 text-right">Annualized TWR</th>
                <th className="px-3 py-2.5 text-right">Cumulative TWR</th>
                <th className="px-3 py-2.5 text-right">Ann. Spread</th>
                <th className="px-3 py-2.5 text-right">Cum. Spread</th>
                <th className="px-3 py-2.5 text-right">Vol / Sharpe</th>
                <th className="px-3 py-2.5 text-right">Max Drawdown</th>
                <th className="py-2.5 pl-3 pr-4 text-right">Beta / α</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              <tr className="bg-accent/8">
                <td className="py-3 pl-4 pr-3">
                  <div className="flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full bg-accent"
                      aria-hidden="true"
                    />
                    <div>
                      <p className="font-semibold text-ink">Your Portfolio</p>
                      <p className="text-[11.5px] text-ink-2">
                        {snapshot.scope.portfolioName} (TWR)
                      </p>
                    </div>
                  </div>
                </td>
                <td className="num px-3 py-3 text-right">
                  <GainBadge percent={performance.annualizedTwrPercent} size="sm" />
                </td>
                <td className="num px-3 py-3 text-right">
                  <GainBadge percent={performance.cumulativeTwrPercent} size="sm" />
                </td>
                <td className="px-3 py-3 text-right">
                  <span className="inline-flex rounded-[6px] bg-accent/12 px-2 py-0.5 text-[11px] font-medium text-accent">
                    Baseline
                  </span>
                </td>
                <td className="px-3 py-3 text-right">
                  <span className="inline-flex rounded-[6px] bg-accent/12 px-2 py-0.5 text-[11px] font-medium text-accent">
                    Baseline
                  </span>
                </td>
                <td className="num px-3 py-3 text-right text-[12.5px] text-ink-2">
                  {performance.volatilityPercent
                    ? `${performance.volatilityPercent}%`
                    : "—"}
                  {" / "}
                  {performance.sharpeRatio ?? "—"}
                </td>
                <td className="num px-3 py-3 text-right text-[12.5px] text-ink-2">
                  {performance.drawdown.maxDrawdownPercent
                    ? formatPercent(performance.drawdown.maxDrawdownPercent)
                    : "—"}
                </td>
                <td className="num py-3 pl-3 pr-4 text-right text-[12px] text-ink-3">
                  —
                </td>
              </tr>

              {activeBenchmarkObjects.map((bench, index) => {
                const ok = bench.status === "ok";
                const color =
                  SERIES_PALETTE[(index + 1) % (SERIES_PALETTE.length - 1)];
                const annSpread = ok
                  ? computeReturnSpread(
                      performance.annualizedTwrPercent,
                      bench.annualizedReturnPercent,
                    )
                  : null;
                const cumSpread = ok
                  ? computeReturnSpread(
                      performance.cumulativeTwrPercent,
                      bench.cumulativeReturnPercent,
                    )
                  : null;

                return (
                  <tr
                    key={bench.symbol}
                    className="transition-colors hover:bg-surface"
                  >
                    <td className="py-3 pl-4 pr-3">
                      <div className="flex items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: color }}
                          aria-hidden="true"
                        />
                        <div>
                          <p className="font-medium text-ink">
                            {resolveBenchmarkLabel(bench.symbol, bench.name)}
                          </p>
                          <p className="font-mono text-[11.5px] text-ink-3">
                            {bench.displaySymbol} · {bench.nativeCurrency}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="num px-3 py-3 text-right">
                      <GainBadge
                        percent={ok ? bench.annualizedReturnPercent : null}
                        size="sm"
                      />
                    </td>
                    <td className="num px-3 py-3 text-right">
                      <GainBadge
                        percent={ok ? bench.cumulativeReturnPercent : null}
                        size="sm"
                      />
                    </td>
                    <td className="num px-3 py-3 text-right">
                      {annSpread !== null ? (
                        <GainBadge percent={annSpread} size="sm" pill />
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                    <td className="num px-3 py-3 text-right">
                      {cumSpread !== null ? (
                        <GainBadge percent={cumSpread} size="sm" pill />
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                    <td className="num px-3 py-3 text-right text-[12.5px] text-ink-2">
                      {ok && bench.annualizedVolatilityPercent
                        ? `${bench.annualizedVolatilityPercent}%`
                        : "—"}
                      {" / "}
                      {ok && bench.sharpeRatio ? bench.sharpeRatio : "—"}
                    </td>
                    <td className="num px-3 py-3 text-right text-[12.5px] text-ink-2">
                      {ok && bench.drawdown.maxDrawdownPercent
                        ? formatPercent(bench.drawdown.maxDrawdownPercent)
                        : "—"}
                    </td>
                    <td className="num py-3 pl-3 pr-4 text-right text-[12px] text-ink-2">
                      {ok && bench.betaVsPortfolio !== null
                        ? `β ${bench.betaVsPortfolio}`
                        : "—"}
                      {" · "}
                      {ok && bench.alphaPercentVsPortfolio
                        ? formatPercent(bench.alphaPercentVsPortfolio, {
                            signed: true,
                          })
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Best & Worst Days / Months */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card className="p-4">
          <p className="text-[12px] font-medium text-ink-2">Best Day</p>
          <div className="mt-1">
            {performance.bestDay ? (
              <GainBadge percent={performance.bestDay.percent} size="sm" />
            ) : (
              <span className="num text-ink-3">—</span>
            )}
          </div>
          <p className="font-mono mt-1 text-[11.5px] text-ink-3">
            {performance.bestDay?.period ?? "—"}
          </p>
        </Card>

        <Card className="p-4">
          <p className="text-[12px] font-medium text-ink-2">Worst Day</p>
          <div className="mt-1">
            {performance.worstDay ? (
              <GainBadge percent={performance.worstDay.percent} size="sm" />
            ) : (
              <span className="num text-ink-3">—</span>
            )}
          </div>
          <p className="font-mono mt-1 text-[11.5px] text-ink-3">
            {performance.worstDay?.period ?? "—"}
          </p>
        </Card>

        <Card className="p-4">
          <p className="text-[12px] font-medium text-ink-2">Best Month</p>
          <div className="mt-1">
            {performance.bestMonth ? (
              <GainBadge percent={performance.bestMonth.percent} size="sm" />
            ) : (
              <span className="num text-ink-3">—</span>
            )}
          </div>
          <p className="font-mono mt-1 text-[11.5px] text-ink-3">
            {performance.bestMonth?.period ?? "—"}
          </p>
        </Card>

        <Card className="p-4">
          <p className="text-[12px] font-medium text-ink-2">Worst Month</p>
          <div className="mt-1">
            {performance.worstMonth ? (
              <GainBadge percent={performance.worstMonth.percent} size="sm" />
            ) : (
              <span className="num text-ink-3">—</span>
            )}
          </div>
          <p className="font-mono mt-1 text-[11.5px] text-ink-3">
            {performance.worstMonth?.period ?? "—"}
          </p>
        </Card>
      </div>

      {/* Drawdown Underwater Chart */}
      <Card className="p-4 sm:p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <h2 className="text-[18px] font-semibold tracking-tight text-ink">
              Underwater Drawdowns
            </h2>
            <MetricTooltip
              label="Drawdown"
              explanation="Shows percentage drops below each historical high-water mark until your portfolio reaches a new record high."
            />
          </div>
          <span className="text-[12.5px] text-ink-2">
            Peak-to-trough declines in {currency} TWR
          </span>
        </div>

        <DrawdownChart
          portfolioDrawdown={performance.drawdown}
          benchmarkOverlay={
            primaryBenchmark && primaryBenchmark.status === "ok"
              ? {
                  label: `${primaryBenchmark.name} (${primaryBenchmark.displaySymbol})`,
                  points: primaryBenchmark.drawdown.points,
                  maxDrawdownPercent:
                    primaryBenchmark.drawdown.maxDrawdownPercent,
                }
              : null
          }
        />
      </Card>
      </div>
    </div>
  );
}

