import { describe, expect, it } from "vitest";
import {
  computeReturnSpread,
  CORE_COMPARISON_BENCHMARKS,
  normalizeBenchmarkSymbol,
  PRESET_BENCHMARKS,
  resolveBenchmarkLabel,
} from "@/lib/benchmarks/summary";

describe("Benchmark Summary Helpers", () => {
  it("exposes VOO, ES3.SI, ONEQ, and DIA as the total-return benchmark ETFs", () => {
    expect(CORE_COMPARISON_BENCHMARKS.map((b) => b.symbol)).toEqual([
      "VOO",
      "ES3.SI",
      "ONEQ",
    ]);
    expect(PRESET_BENCHMARKS.map((b) => b.symbol)).toEqual([
      "VOO",
      "ES3.SI",
      "ONEQ",
      "DIA",
    ]);
  });

  it("maps legacy index tickers onto their total-return fund equivalents", () => {
    expect(normalizeBenchmarkSymbol("^GSPC")).toBe("VOO");
    expect(normalizeBenchmarkSymbol("^STI")).toBe("ES3.SI");
    expect(normalizeBenchmarkSymbol("^IXIC")).toBe("ONEQ");
    expect(normalizeBenchmarkSymbol("^DJI")).toBe("DIA");
    expect(normalizeBenchmarkSymbol("vwra.l")).toBe("VWRA.L");
  });

  it("computes exact percentage-point return spreads and handles missing values", () => {
    expect(computeReturnSpread("18.45", "12.10")).toBe("6.35");
    expect(computeReturnSpread("-4.20", "3.80")).toBe("-8");
    expect(computeReturnSpread(null, "10.00")).toBeNull();
    expect(computeReturnSpread("10.00", undefined)).toBeNull();
  });

  it("resolves clean labels for core benchmarks and falls back safely for custom tickers", () => {
    expect(resolveBenchmarkLabel("VOO", "Vanguard S&P 500 ETF")).toBe(
      "S&P 500",
    );
    expect(resolveBenchmarkLabel("ES3.SI", "SPDR Straits Times Index ETF")).toBe(
      "STI",
    );
    expect(
      resolveBenchmarkLabel("ONEQ", "Fidelity NASDAQ Composite Index ETF"),
    ).toBe("NASDAQ Composite");
    expect(resolveBenchmarkLabel("DIA", "SPDR Dow Jones Industrial Average")).toBe(
      "Dow Jones",
    );
    expect(resolveBenchmarkLabel("SPY", "SPDR S&P 500 ETF Trust")).toBe(
      "SPDR S&P 500 ETF Trust",
    );
    expect(resolveBenchmarkLabel("vwra.l")).toBe("VWRA.L");
  });
});
