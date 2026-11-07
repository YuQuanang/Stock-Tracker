import { describe, expect, it } from "vitest";
import { parseDateAndTimeWithOffset } from "@/lib/finance/date";
import { toDecimal } from "@/lib/finance/decimal";
import { evaluateFifoLedger } from "@/lib/finance/fifo";
import { FxRateBook } from "@/lib/finance/fx";
import {
  computePortfolioWeights,
  computePositionValuation,
} from "@/lib/finance/pnl";

function makeInstant(date: string) {
  return parseDateAndTimeWithOffset(date, "10:00:00", "+0800").executedAt;
}

describe("position P&L and valuation", () => {
  it("computes unrealized P&L, day change, total return, and base-currency metrics", () => {
    const fxBook = new FxRateBook([
      { date: "2024-01-10", fromCurrency: "USD", toCurrency: "SGD", rate: "1.33" },
    ]);

    const fifo = evaluateFifoLedger(
      [
        {
          id: "b1",
          type: "Buy",
          quantity: "10",
          price: "100",
          commissionRaw: "0",
          executedAt: makeInstant("2024-01-10"),
          originalOffset: "+0800",
          currency: "USD",
        },
        {
          id: "d1",
          type: "Dividend",
          quantity: "15",
          price: "105",
          commissionRaw: "0",
          executedAt: makeInstant("2024-01-10"),
          originalOffset: "+0800",
          currency: "USD",
        },
      ],
      { baseCurrency: "SGD", fxRateBook: fxBook },
    );

    const valuation = computePositionValuation(fifo, {
      currency: "USD",
      quote: { price: "120", previousClose: "115", freshness: "closed" },
      currentFxRateToBase: toDecimal("1.35"),
    });

    expect(valuation.isOpenPosition).toBe(true);
    expect(valuation.averageCostPerShare?.toFixed()).toBe("100");
    expect(valuation.marketValue?.toFixed()).toBe("1200");
    expect(valuation.dayChangeAmount?.toFixed()).toBe("50");
    expect(valuation.unrealizedPnl?.toFixed()).toBe("200");
    expect(valuation.unrealizedPnlPercent?.toFixed()).toBe("20");
    expect(valuation.totalReturn?.toFixed()).toBe("215");
    expect(valuation.totalReturnPercent?.toFixed()).toBe("21.5");

    // Base currency: cost = 1000 * 1.33 = 1330 SGD; value = 1200 * 1.35 = 1620 SGD -> +290 SGD
    expect(valuation.costBasisInBase?.toFixed()).toBe("1330");
    expect(valuation.marketValueInBase?.toFixed()).toBe("1620");
    expect(valuation.unrealizedPnlInBase?.toFixed()).toBe("290");
  });

  it("never fabricates market value when price is unavailable", () => {
    const fifo = evaluateFifoLedger([
      {
        id: "b1",
        type: "Buy",
        quantity: "100",
        price: "1.00",
        executedAt: makeInstant("2022-01-01"),
        currency: "USD",
      },
    ]);

    const unpriced = computePositionValuation(fifo, {
      currency: "USD",
      quote: null,
    });
    expect(unpriced.priceSource).toBe("unavailable");
    expect(unpriced.marketValue).toBeNull();
    expect(unpriced.unrealizedPnl).toBeNull();
    expect(unpriced.totalReturn).toBeNull();
  });

  it("honours delisted-worthless and manualPrice overrides", () => {
    const fifo = evaluateFifoLedger([
      {
        id: "b1",
        type: "Buy",
        quantity: "500",
        price: "1.00",
        executedAt: makeInstant("2022-05-01"),
        currency: "USD",
      },
    ]);

    const worthless = computePositionValuation(fifo, {
      currency: "USD",
      isDelisted: true,
    });
    expect(worthless.priceSource).toBe("delisted-worthless");
    expect(worthless.marketValue?.toFixed()).toBe("0");
    expect(worthless.unrealizedPnl?.toFixed()).toBe("-500");

    const manual = computePositionValuation(fifo, {
      currency: "USD",
      isDelisted: true,
      manualPrice: "0.02",
    });
    expect(manual.priceSource).toBe("manual");
    expect(manual.marketValue?.toFixed()).toBe("10");
    expect(manual.unrealizedPnl?.toFixed()).toBe("-490");
  });

  it("handles zero-cost buys without division by zero in unrealizedPnlPercent", () => {
    const fifo = evaluateFifoLedger([
      {
        id: "gift",
        type: "Buy",
        quantity: "10",
        price: "0",
        executedAt: makeInstant("2025-02-05"),
        currency: "USD",
      },
    ]);

    const valuation = computePositionValuation(fifo, {
      currency: "USD",
      quote: { price: "85", freshness: "live" },
    });
    expect(valuation.marketValue?.toFixed()).toBe("850");
    expect(valuation.unrealizedPnl?.toFixed()).toBe("850");
    expect(valuation.unrealizedPnlPercent).toBeNull();
  });

  it("computes portfolio percentage weights cleanly", () => {
    const weights = computePortfolioWeights([
      toDecimal("300"),
      toDecimal("700"),
      null,
      toDecimal("0"),
    ]);
    expect(weights[0]?.toFixed()).toBe("30");
    expect(weights[1]?.toFixed()).toBe("70");
    expect(weights[2]).toBeNull();
    expect(weights[3]?.toFixed()).toBe("0");
  });
});

