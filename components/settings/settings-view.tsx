"use client";

import { useEffect, useRef, useState, type SelectHTMLAttributes } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Download,
  FileUp,
  Monitor,
  Moon,
  Sun,
  Trash2,
} from "lucide-react";
import { PortfolioRenameList } from "@/components/portfolios/portfolio-manage-sheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { GainBadge } from "@/components/ui/gain-badge";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import type { Portfolio, Settings } from "@/db/schema";
import {
  PRESET_BENCHMARKS,
  normalizeBenchmarkSymbol,
} from "@/lib/benchmarks/summary";
import { fadeQuick, springSmooth } from "@/lib/motion";
import {
  GAIN_SCHEME_STORAGE_KEY,
  type GainColorScheme,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "@/lib/theme";
import type { UpdateSettingsPatch } from "@/lib/services/settings";
import { formatSymbolForDisplay } from "@/lib/transactions/form-logic";

interface SettingsViewProps {
  initialSettings: Settings;
  initialPortfolios?: Portfolio[];
}

function SettingsSelect({
  className = "",
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative inline-flex items-center">
      <select
        {...props}
        className={`field-input h-9.5 appearance-none bg-field-bg pr-8 text-[13.5px] ${className}`}
      >
        {children}
      </select>
      <ChevronDown
        size={16}
        className="pointer-events-none absolute right-2.5 text-ink-2"
        aria-hidden="true"
      />
    </div>
  );
}

const CURRENCY_OPTIONS: readonly SegmentedOption<"SGD" | "USD">[] = [
  { value: "SGD", label: "SGD (S$)" },
  { value: "USD", label: "USD (US$)" },
];

const DIVIDEND_OPTIONS: readonly SegmentedOption<"cash" | "shares">[] = [
  { value: "cash", label: "Cash payout" },
  { value: "shares", label: "Reinvested shares" },
];

const THEME_OPTIONS: readonly SegmentedOption<ThemePreference>[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const GAIN_SCHEME_OPTIONS: readonly SegmentedOption<GainColorScheme>[] = [
  { value: "green-up", label: "Green up" },
  { value: "red-up", label: "Red up" },
  { value: "color-blind-safe", label: "Color-blind safe" },
];

const BENCHMARK_PRESETS = PRESET_BENCHMARKS;

function applyDomPreferences(
  theme: ThemePreference,
  gainScheme: GainColorScheme,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    window.localStorage.setItem(GAIN_SCHEME_STORAGE_KEY, gainScheme);
  } catch {
    // Ignore restricted storage mode cleanly.
  }
  document.documentElement.setAttribute("data-theme", "dark");
  document.documentElement.setAttribute("data-gain-scheme", gainScheme);
  window.dispatchEvent(new Event("folio-theme-change"));
}

/**
 * Persisted Portfolio & Display Settings (`components/settings/settings-view.tsx`).
 */
export function SettingsView({
  initialSettings,
  initialPortfolios = [],
}: SettingsViewProps) {
  const router = useRouter();
  const [savedSettings, setSavedSettings] = useState<Settings>(initialSettings);
  const latestSettingsRef = useRef<Settings>(initialSettings);
  const patchSeqRef = useRef(0);
  const fieldSeqRef = useRef<Partial<Record<keyof Settings, number>>>({});
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [riskFreePercentInput, setRiskFreePercentInput] = useState<string>(() =>
    (Number(initialSettings.riskFreeRate) * 100).toFixed(2),
  );
  const [customBenchmarkInput, setCustomBenchmarkInput] = useState<string>(() => {
    const normalized = normalizeBenchmarkSymbol(initialSettings.defaultBenchmark);
    return BENCHMARK_PRESETS.some((b) => b.symbol === normalized) ? "" : normalized;
  });
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Danger Zone Delete Modal
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Sync DOM attributes when server settings arrive without setState
  useEffect(() => {
    applyDomPreferences(
      savedSettings.theme as ThemePreference,
      savedSettings.gainColorScheme as GainColorScheme,
    );
  }, [savedSettings.theme, savedSettings.gainColorScheme]);

  useEffect(() => {
    return () => {
      if (statusTimerRef.current) {
        clearTimeout(statusTimerRef.current);
      }
    };
  }, []);

  async function persistPatch(patch: UpdateSettingsPatch, label: string) {
    const seq = ++patchSeqRef.current;
    const patchKeys = Object.keys(patch) as (keyof UpdateSettingsPatch)[];
    const previousValues: Partial<Settings> = {};
    const nextOptimistic = { ...latestSettingsRef.current };

    for (const key of patchKeys) {
      fieldSeqRef.current[key] = seq;
      (previousValues as Record<string, unknown>)[key] =
        latestSettingsRef.current[key];
      (nextOptimistic as Record<string, unknown>)[key] = patch[key];
    }

    // Apply optimistic state immediately so switches slide in 0ms without server latency.
    latestSettingsRef.current = nextOptimistic;
    setSavedSettings(nextOptimistic);
    setSaveError(null);
    setSaveStatus(null);
    if (statusTimerRef.current) {
      clearTimeout(statusTimerRef.current);
      statusTimerRef.current = null;
    }

    setIsSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.settings) {
        throw new Error(body?.error ?? "Unable to save settings.");
      }

      const serverSettings = body.settings as Settings;
      const merged = { ...latestSettingsRef.current };
      for (const key of patchKeys) {
        if (fieldSeqRef.current[key] === seq) {
          (merged as Record<string, unknown>)[key] = serverSettings[key];
        }
      }
      latestSettingsRef.current = merged;
      setSavedSettings(merged);

      if (seq === patchSeqRef.current) {
        setSaveStatus(`${label} saved`);
        statusTimerRef.current = setTimeout(() => {
          setSaveStatus(null);
        }, 2800);
        router.refresh();
      }
    } catch (error) {
      const reverted = { ...latestSettingsRef.current };
      for (const key of patchKeys) {
        if (fieldSeqRef.current[key] === seq && key in previousValues) {
          (reverted as Record<string, unknown>)[key] = previousValues[key];
        }
      }
      latestSettingsRef.current = reverted;
      setSavedSettings(reverted);

      if (seq === patchSeqRef.current) {
        setSaveError(
          error instanceof Error ? error.message : "Unable to update settings.",
        );
      }
    } finally {
      if (seq === patchSeqRef.current) {
        setIsSaving(false);
      }
    }
  }

  function handleSaveRiskFreeRate() {
    const num = Number(riskFreePercentInput.trim());
    if (!Number.isFinite(num) || num < 0 || num > 25) {
      setSaveError("Risk-free rate must be between 0% and 25%.");
      return;
    }
    const decimalFraction = (num / 100).toFixed(6);
    void persistPatch({ riskFreeRate: decimalFraction }, "Risk-free rate");
  }

  async function handleConfirmDeleteAllData() {
    if (confirmText.trim() !== "DELETE ALL DATA") {
      return;
    }
    setIsDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch("/api/settings/data", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation: "DELETE ALL DATA" }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error ?? "Unable to delete portfolio data.");
      }
      applyDomPreferences("system", "green-up");
      setDeleteDialogOpen(false);
      router.push("/dashboard");
      router.refresh();
    } catch (error) {
      setDeleteError(
        error instanceof Error
          ? error.message
          : "Unable to clear portfolio data.",
      );
    } finally {
      setIsDeleting(false);
    }
  }

  const [portfoliosList, setPortfoliosList] =
    useState<Portfolio[]>(initialPortfolios);
  const holdingsPortfolios = portfoliosList.filter((p) => p.type === "holdings");
  const resolvedDefaultPortfolioId =
    savedSettings.defaultPortfolioId &&
    savedSettings.defaultPortfolioId !== "all" &&
    holdingsPortfolios.some((p) => p.id === savedSettings.defaultPortfolioId)
      ? savedSettings.defaultPortfolioId
      : "all";

  const currentTheme = savedSettings.theme as ThemePreference;
  const currentGainScheme = savedSettings.gainColorScheme as GainColorScheme;

  return (
    <div className="space-y-6">
      <AnimatePresence initial={false}>
        {(saveStatus || saveError) && (
          <motion.div
            key={saveError ? "settings-error" : "settings-status"}
            role={saveError ? "alert" : "status"}
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={fadeQuick}
            className={`flex items-center gap-2 rounded-[12px] border px-4 py-2.5 text-[13px] ${
              saveError
                ? "border-loss/30 bg-loss/10 text-loss"
                : "border-accent/30 bg-accent/10 text-accent"
            }`}
          >
            {saveError ? (
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            ) : (
              <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
            )}
            <span>{saveError ?? saveStatus}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Section 1: Portfolio & Calculation Settings */}
      <section className="space-y-2.5">
        <h2 className="px-1 text-[13px] font-medium text-ink-2">
          Portfolio &amp; Calculations
        </h2>
        <Card className="divide-y divide-line">
          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6 sm:py-4.5">
            <div className="min-w-0 max-w-md">
              <label
                htmlFor="settings-default-portfolio"
                className="font-medium text-ink"
              >
                Default Portfolio Displayed
              </label>
              <p className="text-[13.5px] text-ink-2">
                Initial portfolio selected when opening Dashboard, Holdings,
                Benchmarks, and Transactions.
              </p>
            </div>
            <SettingsSelect
              id="settings-default-portfolio"
              value={resolvedDefaultPortfolioId}
              disabled={isSaving}
              onChange={(e) => {
                const nextId = e.target.value;
                if (nextId !== resolvedDefaultPortfolioId) {
                  void persistPatch(
                    { defaultPortfolioId: nextId },
                    "Default portfolio",
                  );
                }
              }}
            >
              <option value="all">
                All Portfolios ({holdingsPortfolios.length})
              </option>
              {holdingsPortfolios.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </SettingsSelect>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6 sm:py-4.5">
            <div className="min-w-0 max-w-md">
              <p className="font-medium text-ink">Base Currency</p>
              <p className="text-[13.5px] text-ink-2">
                Default reporting currency across Holdings, Dashboard, and
                Benchmark analytics.
              </p>
            </div>
            <SegmentedControl
              ariaLabel="Default base currency"
              options={CURRENCY_OPTIONS}
              value={savedSettings.baseCurrency === "USD" ? "USD" : "SGD"}
              layoutId="settings-base-currency-seg"
              onChange={(next) => {
                if (next !== savedSettings.baseCurrency) {
                  void persistPatch({ baseCurrency: next }, "Base currency");
                }
              }}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6 sm:py-4.5">
            <div className="min-w-0 max-w-md">
              <label
                htmlFor="settings-risk-free-rate"
                className="font-medium text-ink"
              >
                Risk-Free Rate (%)
              </label>
              <p className="text-[13.5px] text-ink-2">
                Annualized baseline rate used for Sharpe Ratio and Jensen&apos;s
                Alpha (e.g. 3.50% for Singapore T-Bills).
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <input
                  id="settings-risk-free-rate"
                  type="number"
                  min={0}
                  max={25}
                  step={0.05}
                  value={riskFreePercentInput}
                  onChange={(e) => setRiskFreePercentInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleSaveRiskFreeRate();
                    }
                  }}
                  className="field-input num h-9.5 w-26 bg-field-bg pl-3 pr-7 text-[13.5px]"
                />
                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[12.5px] text-ink-2">
                  %
                </span>
              </div>
              <Button
                variant="secondary"
                disabled={isSaving}
                onClick={handleSaveRiskFreeRate}
                className="h-9.5! px-3.5! text-[13px]!"
              >
                Apply
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6 sm:py-4.5">
            <div className="min-w-0 max-w-md">
              <label
                htmlFor="settings-default-benchmark"
                className="font-medium text-ink"
              >
                Default Benchmark
              </label>
              <p className="text-[13.5px] text-ink-2">
                Initial focus index selected on Benchmarks &amp; Watchlist paper
                simulations.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <SettingsSelect
                id="settings-default-benchmark"
                value={
                  BENCHMARK_PRESETS.some(
                    (b) =>
                      b.symbol ===
                      normalizeBenchmarkSymbol(savedSettings.defaultBenchmark),
                  )
                    ? normalizeBenchmarkSymbol(savedSettings.defaultBenchmark)
                    : "__custom__"
                }
                onChange={(e) => {
                  if (e.target.value !== "__custom__") {
                    setCustomBenchmarkInput("");
                    void persistPatch(
                      { defaultBenchmark: e.target.value },
                      "Default benchmark",
                    );
                  }
                }}
              >
                {BENCHMARK_PRESETS.map((b) => (
                  <option key={b.symbol} value={b.symbol}>
                    {b.label} ({formatSymbolForDisplay(b.symbol)})
                  </option>
                ))}
                <option value="__custom__">Custom symbol…</option>
              </SettingsSelect>

              {(!BENCHMARK_PRESETS.some(
                (b) =>
                  b.symbol ===
                  normalizeBenchmarkSymbol(savedSettings.defaultBenchmark),
              ) ||
                customBenchmarkInput !== "") && (
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={customBenchmarkInput}
                    onChange={(e) => setCustomBenchmarkInput(e.target.value)}
                    placeholder="e.g. SPY"
                    aria-label="Custom default benchmark symbol"
                    className="field-input h-9.5 w-28 bg-field-bg px-2.5 text-[13px] uppercase"
                  />
                  <Button
                    variant="secondary"
                    disabled={isSaving || !customBenchmarkInput.trim()}
                    onClick={() =>
                      void persistPatch(
                        {
                          defaultBenchmark: customBenchmarkInput
                            .trim()
                            .toUpperCase(),
                        },
                        "Default benchmark",
                      )
                    }
                    className="h-9.5! px-3! text-[12.5px]!"
                  >
                    Save
                  </Button>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6 sm:py-4.5">
            <div className="min-w-0 max-w-md">
              <p className="font-medium text-ink">Dividend Interpretation</p>
              <p className="text-[13.5px] text-ink-2">
                Treat Dividend rows as cash income (default for MSN Money CSV
                imports) or reinvested share lots. Toggling recalculates
                historical dividend SGD snapshots.
              </p>
            </div>
            <SegmentedControl
              ariaLabel="Dividend interpretation mode"
              options={DIVIDEND_OPTIONS}
              value={
                savedSettings.dividendMode === "shares" ? "shares" : "cash"
              }
              layoutId="settings-dividend-mode-seg"
              onChange={(next) => {
                if (next !== savedSettings.dividendMode) {
                  void persistPatch(
                    { dividendMode: next },
                    "Dividend interpretation",
                  );
                }
              }}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6 sm:py-4.5">
            <div className="min-w-0">
              <p className="font-medium text-ink">Cost Basis Accounting</p>
              <p className="text-[13.5px] text-ink-2">
                Tax-lot matching across all transactions and Sell All events.
              </p>
            </div>
            <span className="rounded-[8px] border border-line bg-surface-2 px-3 py-1 text-[12.5px] font-medium text-ink">
              FIFO (First-In, First-Out)
            </span>
          </div>

          <div className="space-y-3 px-4 py-4 sm:px-6 sm:py-4.5">
            <div>
              <p className="font-medium text-ink">Portfolios &amp; Watchlists</p>
              <p className="text-[13.5px] text-ink-2">
                Rename or delete any holdings portfolio or watchlist across your
                ledger and exports.
              </p>
            </div>
            <PortfolioRenameList
              portfolios={portfoliosList}
              defaultPortfolioId={resolvedDefaultPortfolioId}
              showTypeBadge
              allowDelete
              onRenamed={(updated) => {
                setPortfoliosList((prev) =>
                  prev.map((p) => (p.id === updated.id ? updated : p)),
                );
                setSaveError(null);
                setSaveStatus(`Renamed portfolio to "${updated.name}"`);
                if (statusTimerRef.current) {
                  clearTimeout(statusTimerRef.current);
                }
                statusTimerRef.current = setTimeout(() => {
                  setSaveStatus(null);
                }, 2200);
                router.refresh();
              }}
              onDeleted={(deleted) => {
                setPortfoliosList((prev) =>
                  prev.filter((p) => p.id !== deleted.id),
                );
                if (savedSettings.defaultPortfolioId === deleted.id) {
                  const nextSettings = {
                    ...latestSettingsRef.current,
                    defaultPortfolioId: "all",
                  };
                  latestSettingsRef.current = nextSettings;
                  setSavedSettings(nextSettings);
                }
                setSaveError(null);
                setSaveStatus(`Deleted portfolio "${deleted.name}"`);
                if (statusTimerRef.current) {
                  clearTimeout(statusTimerRef.current);
                }
                statusTimerRef.current = setTimeout(() => {
                  setSaveStatus(null);
                }, 2800);
                router.refresh();
              }}
              emptyMessage="No portfolios or watchlists created yet."
            />
          </div>
        </Card>
      </section>

      {/* Section 2: Appearance & Display */}
      <section className="space-y-2.5">
        <h2 className="px-1 text-[13px] font-medium text-ink-2">
          Appearance &amp; Display
        </h2>
        <Card className="divide-y divide-line">
          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6 sm:py-4.5">
            <div className="min-w-0">
              <p className="font-medium text-ink">Theme</p>
              <p className="text-[13.5px] text-ink-2">
                Dark Graphite is active across all views; stored preference is
                preserved.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-ink-2" aria-hidden="true">
                {currentTheme === "dark" ? (
                  <Moon className="h-4 w-4" />
                ) : currentTheme === "light" ? (
                  <Sun className="h-4 w-4" />
                ) : (
                  <Monitor className="h-4 w-4" />
                )}
              </span>
              <SegmentedControl
                ariaLabel="Theme preference"
                options={THEME_OPTIONS}
                value={currentTheme}
                layoutId="settings-theme-seg"
                onChange={(next) => {
                  applyDomPreferences(next, currentGainScheme);
                  void persistPatch({ theme: next }, "Theme");
                }}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6 sm:py-4.5">
            <div className="min-w-0 space-y-1">
              <p className="font-medium text-ink">Gain / Loss Color Scheme</p>
              <p className="text-[13.5px] text-ink-2">
                Customize positive &amp; negative directional highlights across
                cards, badges, and charts.
              </p>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-[12px] text-ink-2">Preview:</span>
                <GainBadge
                  amount="1240.50"
                  currency={savedSettings.baseCurrency}
                  percent="12.40"
                  size="sm"
                  pill
                />
                <GainBadge
                  amount="-310.20"
                  currency={savedSettings.baseCurrency}
                  percent="-4.15"
                  size="sm"
                  pill
                />
              </div>
            </div>
            <SegmentedControl
              ariaLabel="Gain and loss color scheme"
              options={GAIN_SCHEME_OPTIONS}
              value={currentGainScheme}
              layoutId="settings-gain-scheme-seg"
              onChange={(next) => {
                applyDomPreferences(currentTheme, next);
                void persistPatch({ gainColorScheme: next }, "Color scheme");
              }}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6 sm:py-4.5">
            <div className="min-w-0">
              <label
                htmlFor="settings-number-format"
                className="font-medium text-ink"
              >
                Number Format
              </label>
              <p className="text-[13.5px] text-ink-2">
                Grouping and currency symbol convention.
              </p>
            </div>
            <SettingsSelect
              id="settings-number-format"
              value={savedSettings.numberFormat}
              onChange={(e) =>
                void persistPatch(
                  { numberFormat: e.target.value as "en-SG" | "en-US" },
                  "Number format",
                )
              }
            >
              <option value="en-SG">Singapore (en-SG)</option>
              <option value="en-US">United States (en-US)</option>
            </SettingsSelect>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6 sm:py-4.5">
            <div className="min-w-0">
              <label
                htmlFor="settings-date-format"
                className="font-medium text-ink"
              >
                Date Format &amp; Timezone
              </label>
              <p className="text-[13.5px] text-ink-2">
                Display preference for dates and market session timestamps.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <SettingsSelect
                id="settings-date-format"
                value={savedSettings.dateFormat}
                onChange={(e) =>
                  void persistPatch(
                    {
                      dateFormat: e.target.value as
                        | "dd MMM yyyy"
                        | "yyyy-MM-dd"
                        | "MM/dd/yyyy",
                    },
                    "Date format",
                  )
                }
              >
                <option value="dd MMM yyyy">07 Nov 2026</option>
                <option value="yyyy-MM-dd">2026-11-07</option>
                <option value="MM/dd/yyyy">11/07/2026</option>
              </SettingsSelect>

              <SettingsSelect
                aria-label="Timezone"
                value={savedSettings.timezone}
                onChange={(e) =>
                  void persistPatch({ timezone: e.target.value }, "Timezone")
                }
              >
                <option value="Asia/Singapore">Asia/Singapore (SGT)</option>
                <option value="America/New_York">America/New_York (ET)</option>
                <option value="UTC">UTC</option>
                <option value="Europe/London">Europe/London (GMT/BST)</option>
              </SettingsSelect>
            </div>
          </div>
        </Card>
      </section>

      {/* Section 3: Data & Backups */}
      <section className="space-y-2.5">
        <h2 className="px-1 text-[13px] font-medium text-ink-2">
          Data &amp; Backups
        </h2>
        <Card className="divide-y divide-line">
          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6 sm:py-4.5">
            <div className="min-w-0">
              <p className="font-medium text-ink">Export Portfolio Ledger</p>
              <p className="text-[13.5px] text-ink-2">
                Download your lossless MSP/MSN CSV, clean normalized CSV, or full
                JSON snapshot anytime.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a
                href="/api/import-export/export?format=msp"
                className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-line bg-surface-2 px-3 text-[13px] font-medium text-ink transition-colors hover:bg-surface active:scale-[0.98]"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                MSP CSV
              </a>
              <a
                href="/api/import-export/export?format=clean"
                className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-line bg-surface-2 px-3 text-[13px] font-medium text-ink transition-colors hover:bg-surface active:scale-[0.98]"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                Clean CSV
              </a>
              <a
                href="/api/import-export/export?format=backup"
                className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-line bg-surface-2 px-3 text-[13px] font-medium text-ink transition-colors hover:bg-surface active:scale-[0.98]"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                Full JSON
              </a>
              <Link
                href="/import-export"
                className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-line px-3 text-[13px] font-medium text-accent transition-colors hover:bg-accent/8 active:scale-[0.98]"
              >
                <FileUp className="h-3.5 w-3.5" aria-hidden="true" />
                Import &amp; Export
              </Link>
            </div>
          </div>
        </Card>
      </section>

      {/* Section 4: Danger Zone */}
      <section className="space-y-2.5">
        <h2 className="px-1 text-[13px] font-semibold uppercase tracking-[0.05em] text-loss">
          Danger Zone
        </h2>
        <Card className="border-loss/35 p-4 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0 max-w-lg">
              <p className="font-semibold text-ink">Delete All Portfolio Data</p>
              <p className="mt-0.5 text-[13.5px] text-ink-2">
                Permanently removes all portfolios, watchlists, transactions,
                corporate splits, CSV import history, and cached market bars, and
                resets settings back to factory defaults. This cannot be undone.
              </p>
            </div>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmText("");
                setDeleteError(null);
                setDeleteDialogOpen(true);
              }}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              Delete All Data
            </Button>
          </div>
        </Card>
      </section>

      {/* Confirmation Dialog Modal */}
      <AnimatePresence>
        {deleteDialogOpen && (
          <motion.div
            key="delete-all-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-all-title"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={fadeQuick}
            className="fixed inset-0 z-50 flex items-center justify-center bg-[#090B10]/75 p-4"
            onClick={(e) => {
              if (e.target === e.currentTarget && !isDeleting) {
                setDeleteDialogOpen(false);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && !isDeleting) {
                setDeleteDialogOpen(false);
              }
            }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97, y: 6 }}
              transition={springSmooth}
              className="w-full max-w-md"
            >
              <Card raised className="space-y-4 p-5 sm:p-6">
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border border-line bg-surface-2 text-ink-2">
                    <AlertTriangle className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <h3
                      id="delete-all-title"
                      className="text-[17px] font-semibold text-ink"
                    >
                      Delete all portfolio data?
                    </h3>
                    <p className="mt-1 text-[13.5px] leading-[1.45] text-ink-2">
                      Download a Full JSON or MSP CSV backup first if you may
                      want this ledger later. Type{" "}
                      <strong className="font-semibold text-ink">
                        DELETE ALL DATA
                      </strong>{" "}
                      below to confirm.
                    </p>
                  </div>
                </div>

                <input
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="DELETE ALL DATA"
                  aria-label="Confirmation text"
                  autoFocus
                  className="field-input h-10 w-full bg-field-bg text-[14px] focus:border-loss"
                />

                {deleteError && (
                  <p className="text-[13px] text-loss" role="alert">
                    {deleteError}
                  </p>
                )}

                <div className="flex items-center justify-end gap-2.5 pt-1">
                  <Button
                    variant="secondary"
                    disabled={isDeleting}
                    onClick={() => setDeleteDialogOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="danger"
                    disabled={
                      isDeleting || confirmText.trim() !== "DELETE ALL DATA"
                    }
                    onClick={() => void handleConfirmDeleteAllData()}
                  >
                    {isDeleting ? "Deleting…" : "Confirm Permanent Delete"}
                  </Button>
                </div>
              </Card>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

