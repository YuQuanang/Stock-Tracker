import { toDecimalString, toOptionalDecimal } from "@/lib/finance/decimal";

export interface BenchmarkPreset {
  symbol: string;
  label: string;
}

/** Core comparison indexes shown in the Dashboard TWR summary. */
export const CORE_COMPARISON_BENCHMARKS: readonly BenchmarkPreset[] = [
  { symbol: "^GSPC", label: "S&P 500" },
  { symbol: "^STI", label: "STI" },
  { symbol: "^IXIC", label: "NASDAQ" },
];

/** Default preset benchmark chips shown on `/benchmarks`. */
export const PRESET_BENCHMARKS: readonly BenchmarkPreset[] = [
  ...CORE_COMPARISON_BENCHMARKS,
  { symbol: "^DJI", label: "Dow Jones" },
];

const BENCHMARK_LABEL_MAP = new Map<string, string>(
  PRESET_BENCHMARKS.map((preset) => [preset.symbol, preset.label]),
);

/** Resolves a concise Apple-clean benchmark display name for UI tables and legends. */
export function resolveBenchmarkLabel(
  symbol: string,
  fetchedName?: string | null,
): string {
  const upper = symbol.trim().toUpperCase();
  return BENCHMARK_LABEL_MAP.get(upper) ?? fetchedName ?? upper;
}

/**
 * Computes exact percentage-point spread (`portfolioPct - benchmarkPct`),
 * returning `null` if either return is missing.
 */
export function computeReturnSpread(
  portfolioPct: string | null | undefined,
  benchmarkPct: string | null | undefined,
): string | null {
  const p = toOptionalDecimal(portfolioPct);
  const b = toOptionalDecimal(benchmarkPct);
  if (!p || !b) {
    return null;
  }
  return toDecimalString(p.minus(b), 2);
}

