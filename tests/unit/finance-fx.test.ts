import { describe, expect, it } from "vitest";
import { toDecimal } from "@/lib/finance/decimal";
import {
  convertCurrencyAmount,
  FxRateBook,
  lookupFxRate,
} from "@/lib/finance/fx";

describe("FX rate lookup and conversion", () => {
  const rateBook = new FxRateBook([
    { date: "2026-11-05", fromCurrency: "USD", toCurrency: "SGD", rate: "1.3410" },
    { date: "2026-11-06", fromCurrency: "USD", toCurrency: "SGD", rate: "1.3450" },
  ]);

  it("returns 1 for identical currencies", () => {
    const res = lookupFxRate({
      fromCurrency: "SGD",
      toCurrency: "SGD",
      date: "2026-11-07",
      rateBook,
    });
    expect(res.source).toBe("identity");
    expect(res.rate?.toFixed()).toBe("1");
  });

  it("matches exact date and supports inverse currency lookup", () => {
    const direct = lookupFxRate({
      fromCurrency: "USD",
      toCurrency: "SGD",
      date: "2026-11-06",
      rateBook,
    });
    expect(direct.source).toBe("exact");
    expect(direct.rate?.toFixed()).toBe("1.345");

    const inverse = lookupFxRate({
      fromCurrency: "SGD",
      toCurrency: "USD",
      date: "2026-11-06",
      rateBook,
    });
    expect(inverse.source).toBe("exact");
    const roundTrip = convertCurrencyAmount(
      convertCurrencyAmount(toDecimal("100"), direct.rate),
      inverse.rate,
    );
    expect(roundTrip?.toDecimalPlaces(8).toFixed()).toBe("100");
  });

  it("falls back to prior business day on weekends (Saturday 2026-11-07 -> Friday 2026-11-06)", () => {
    const weekend = lookupFxRate({
      fromCurrency: "USD",
      toCurrency: "SGD",
      date: "2026-11-07",
      rateBook,
    });
    expect(weekend.source).toBe("prior-business-day");
    expect(weekend.effectiveDate).toBe("2026-11-06");
    expect(weekend.rate?.toFixed()).toBe("1.345");
  });

  it("prefers explicit per-transaction FX rate and inverts reversed pair labels", () => {
    const explicit = lookupFxRate({
      fromCurrency: "USD",
      toCurrency: "SGD",
      date: "2026-11-06",
      explicitRate: "1.3600",
      explicitCurrencies: "USD/SGD",
      rateBook,
    });
    expect(explicit.source).toBe("transaction");
    expect(explicit.rate?.toFixed()).toBe("1.36");

    const reversedExplicit = lookupFxRate({
      fromCurrency: "USD",
      toCurrency: "SGD",
      date: "2026-11-06",
      explicitRate: "0.8",
      explicitCurrencies: "SGD/USD",
      rateBook,
    });
    expect(reversedExplicit.source).toBe("transaction");
    expect(reversedExplicit.rate?.toFixed()).toBe("1.25");
  });

  it("never invents a rate when none exists within the lookback window", () => {
    const missing = lookupFxRate({
      fromCurrency: "USD",
      toCurrency: "SGD",
      date: "2021-01-01",
      rateBook,
    });
    expect(missing.source).toBe("missing");
    expect(missing.rate).toBeNull();
  });
});

