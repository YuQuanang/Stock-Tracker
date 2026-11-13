import { describe, expect, it } from "vitest";
import {
  computeReturnSpread,
  CORE_COMPARISON_BENCHMARKS,
  resolveBenchmarkLabel,
} from "@/lib/benchmarks/summary";

describe("Benchmark Summary Helpers", () => {
  it("exposes S&P 500, STI, and NASDAQ as the core comparison benchmarks", () => {
    expect(CORE_COMPARISON_BENCHMARKS.map((b) => b.symbol)).toEqual([
      "^GSPC",
      "^STI",
      "^IXIC",
    ]);
  });

  it("computes exact percentage-point return spreads and handles missing values", () => {
    expect(computeReturnSpread("18.45", "12.10")).toBe("6.35");
    expect(computeReturnSpread("-4.20", "3.80")).toBe("-8");
    expect(computeReturnSpread(null, "10.00")).toBeNull();
    expect(computeReturnSpread("10.00", undefined)).toBeNull();
  });

  it("resolves clean labels for core benchmarks and falls back safely for custom tickers", () => {
    expect(resolveBenchmarkLabel("^GSPC", "Standard & Poor's 500")).toBe(
      "S&P 500",
    );
    expect(resolveBenchmarkLabel("^STI", "FTSE Straits Times")).toBe("STI");
    expect(resolveBenchmarkLabel("^IXIC", "NASDAQ Composite")).toBe("NASDAQ");
    expect(resolveBenchmarkLabel("SPY", "SPDR S&P 500 ETF Trust")).toBe(
      "SPDR S&P 500 ETF Trust",
    );
    expect(resolveBenchmarkLabel("es3.si")).toBe("ES3.SI");
  });
});

