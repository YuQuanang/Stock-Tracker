import { describe, expect, it } from "vitest";
import { formatCompactFreshness, formatMoney } from "@/lib/format";

describe("formatMoney", () => {
  it("caps all formatted prices and monetary values at max 2 decimal places", () => {
    expect(formatMoney("0.919", "SGD")).toBe("$0.92");
    expect(formatMoney(0.0549, "USD")).toBe("US$0.05");
    expect(formatMoney("12.3456", "USD")).toBe("US$12.35");
    expect(formatMoney("12.3456", "USD", { maximumFractionDigits: 4 })).toBe("US$12.35");
    expect(formatMoney(50.5, "USD")).toBe("US$50.50");
    expect(formatMoney("-0.919", "SGD", { signed: true })).toBe("−$0.92");
    expect(formatMoney("1234.56", "SGD", { maximumFractionDigits: 0 })).toBe("$1,235");
    expect(formatMoney(null, "USD")).toBe("—");
  });
});

describe("formatCompactFreshness", () => {
  it("strips verbose close prefixes while preserving the date", () => {
    expect(formatCompactFreshness("Last close, 13 Nov")).toBe("13 Nov");
    expect(formatCompactFreshness("Cached close, 6 Nov")).toBe("6 Nov");
    expect(formatCompactFreshness("Close on 2 Jan")).toBe("2 Jan");
  });

  it("compacts status labels concisely and handles empty input", () => {
    expect(formatCompactFreshness("Delayed ~15 min")).toBe("Delayed");
    expect(formatCompactFreshness("Manual price")).toBe("Manual");
    expect(formatCompactFreshness("Delisted / Worthless")).toBe("Delisted");
    expect(formatCompactFreshness("Price unavailable")).toBe("Unavailable");
    expect(formatCompactFreshness("Price not found")).toBe("Not found");
    expect(formatCompactFreshness("Live")).toBe("Live");
    expect(formatCompactFreshness(null)).toBe("—");
    expect(formatCompactFreshness("")).toBe("—");
  });
});

