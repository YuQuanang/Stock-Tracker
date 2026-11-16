/**
 * Shared Benchmark Definitions & Summary Math (`lib/benchmarks/summary.ts`).
 *
 * Uses dividend-adjusted total-return ETFs converted into the user's selected
 * reporting currency (`SGD` by default) so comparisons include reinvested
 * dividends rather than price-only index levels:
 *   - S&P 500:          VOO
 *   - STI:              ES3.SI
 *   - NASDAQ Composite: ONEQ
 *   - Dow Jones:        DIA
 */
import { safeDivide, toDecimal, toDecimalString, toOptionalDecimal } from "@/lib/finance/decimal";

export interface BenchmarkPreset {
  symbol: string;
  label: string;
}

export const CORE_COMPARISON_BENCHMARKS: readonly BenchmarkPreset[] = [
  { symbol: "VOO", label: "S&P 500" },
  { symbol: "ES3.SI", label: "STI" },
  { symbol: "ONEQ", label: "NASDAQ Composite" },
];

export const PRESET_BENCHMARKS: readonly BenchmarkPreset[] = [
  ...CORE_COMPARISON_BENCHMARKS,
  { symbol: "DIA", label: "Dow Jones" },
];

export const DEFAULT_FOCUS_BENCHMARK = "VOO";

const LEGACY_BENCHMARK_SYMBOL_MAP: Record<string, string> = {
  "^GSPC": "VOO",
  GSPC: "VOO",
  "^STI": "ES3.SI",
  STI: "ES3.SI",
  "^IXIC": "ONEQ",
  IXIC: "ONEQ",
  "^DJI": "DIA",
  DJI: "DIA",
};

const PRESET_LABEL_BY_SYMBOL = new Map<string, string>(
  PRESET_BENCHMARKS.map((preset) => [preset.symbol.toUpperCase(), preset.label]),
);

/**
 * Maps legacy price-index tickers (`^GSPC`, `^STI`, `^IXIC`, `^DJI`) saved in
 * older settings rows onto their total-return ETF equivalents while preserving
 * any custom ETF or stock ticker entered by the user.
 */
export function normalizeBenchmarkSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  if (!upper) return DEFAULT_FOCUS_BENCHMARK;
  return LEGACY_BENCHMARK_SYMBOL_MAP[upper] ?? upper;
}

export function resolveBenchmarkLabel(symbol: string, rawName?: string | null): string {
  const canonical = normalizeBenchmarkSymbol(symbol);
  const preset = PRESET_LABEL_BY_SYMBOL.get(canonical);
  if (preset) return preset;
  const trimmed = rawName?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : canonical;
}

export function computeReturnSpread(
  portfolioReturnPercent: string | null | undefined,
  benchmarkReturnPercent: string | null | undefined,
): string | null {
  const port = toOptionalDecimal(portfolioReturnPercent);
  const bench = toOptionalDecimal(benchmarkReturnPercent);
  if (port === null || bench === null) return null;
  const spread = port.minus(bench);
  if (!spread.isFinite()) return null;
  // Sanity check through Decimal helper so -0.00 collapses cleanly to 0.00
  const normalized = safeDivide(spread, toDecimal(1)) ?? spread;
  return toDecimalString(normalized, 2);
}
