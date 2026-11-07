import { describe, expect, it } from "vitest";
import { parseDateAndTimeWithOffset } from "@/lib/finance/date";
import {
  evaluateFifoLedger,
  FifoValidationError,
  type LedgerTransactionInput,
} from "@/lib/finance/fifo";
import { FxRateBook } from "@/lib/finance/fx";

function tx(
  overrides: Partial<LedgerTransactionInput> & {
    id: string;
    type: LedgerTransactionInput["type"];
    quantity: string | number;
    price: string | number;
    date: string;
    time?: string;
  },
): LedgerTransactionInput {
  const parsed = parseDateAndTimeWithOffset(
    overrides.date,
    overrides.time ?? "09:30:00",
    "+0800",
  );
  return {
    id: overrides.id,
    type: overrides.type,
    quantity: overrides.quantity,
    price: overrides.price,
    commissionRaw: overrides.commissionRaw ?? "0",
    executedAt: parsed.executedAt,
    originalOffset: parsed.originalOffset,
    currency: overrides.currency ?? "USD",
    purchaseFxRate: overrides.purchaseFxRate ?? null,
    purchaseFxCurrencies: overrides.purchaseFxCurrencies ?? null,
    sourceRowId: overrides.sourceRowId ?? null,
  };
}

describe("FIFO ledger engine", () => {
  it("matches partial sells against the oldest lots first and preserves exact cost basis", () => {
    const result = evaluateFifoLedger([
      tx({ id: "b1", type: "Buy", quantity: 10, price: 100, commissionRaw: "2", date: "2023-01-10" }),
      tx({ id: "b2", type: "Buy", quantity: 10, price: 120, commissionRaw: "0", date: "2023-02-10" }),
      tx({ id: "s1", type: "Sell", quantity: 15, price: 150, commissionRaw: "3", date: "2023-03-10" }),
    ]);

    // Remaining: 5 shares from b2 at $120 = $600 cost basis
    expect(result.sharesHeld.toFixed()).toBe("5");
    expect(result.openLots).toHaveLength(1);
    expect(result.openLots[0].buyTransactionId).toBe("b2");
    expect(result.openCostBasis.toFixed()).toBe("600");

    // Closed: 10 shares of b1 (cost 1002) + 5 shares of b2 (cost 600) = 1602
    // Net proceeds = 15 * 150 - 3 = 2247 -> realized P&L = 2247 - 1602 = 645
    expect(result.closedLotMatches).toHaveLength(2);
    expect(result.realizedPnl.toFixed()).toBe("645");
    expect(result.closedTradeCount).toBe(1);
    expect(result.winningTradeCount).toBe(1);
  });

  it("handles Sell All with quantity 0 by selling every remaining open share", () => {
    const result = evaluateFifoLedger([
      tx({ id: "b1", type: "Buy", quantity: 4, price: 50, date: "2024-01-01" }),
      tx({ id: "b2", type: "Buy", quantity: 6, price: 60, date: "2024-02-01" }),
      tx({ id: "sa", type: "Sell All", quantity: 0, price: 70, commissionRaw: "5", date: "2024-03-01" }),
    ]);

    expect(result.sharesHeld.toFixed()).toBe("0");
    expect(result.openCostBasis.toFixed()).toBe("0");
    // Cost = 200 + 360 = 560; net proceeds = 10 * 70 - 5 = 695; realized = 135
    expect(result.realizedPnl.toFixed()).toBe("135");
  });

  it("handles real CFA.SI sequence with cash dividends and 1% sell commission", () => {
    const result = evaluateFifoLedger(
      [
        tx({ id: "154", type: "Buy", quantity: 50, price: "1.12", currency: "SGD", date: "2021-05-18" }),
        tx({ id: "155", type: "Buy", quantity: 200, price: "1.14", currency: "SGD", date: "2021-06-14" }),
        tx({ id: "156", type: "Dividend", quantity: "2.87", price: "1.09", currency: "SGD", date: "2021-08-04" }),
        tx({ id: "157", type: "Buy", quantity: 90, price: "1.08", commissionRaw: "1.07", currency: "SGD", date: "2022-01-06" }),
        tx({ id: "169", type: "Sell", quantity: 340, price: "0.919", commissionRaw: "1%", currency: "SGD", date: "2023-01-16", time: "13:05:00" }),
        tx({ id: "170", type: "Buy", quantity: 340, price: "0.92", currency: "SGD", date: "2023-01-16", time: "13:06:00" }),
      ],
      { symbol: "CFA.SI", dividendMode: "cash" },
    );

    expect(result.sharesHeld.toFixed()).toBe("340");
    expect(result.openCostBasis.toFixed()).toBe("312.8");
    expect(result.dividendsReceived.toFixed()).toBe("2.87");

    // Prior buys cost = 56 + 228 + (97.2 + 1.07) = 382.27
    // Sell 340 @ 0.919 = 312.46 gross; 1% commission = 3.1246 -> net 309.3354
    // Realized P&L = 309.3354 - 382.27 = -72.9346
    expect(result.realizedPnl.toFixed()).toBe("-72.9346");
  });

  it("supports reinvested-shares dividend mode when toggled in Settings", () => {
    const result = evaluateFifoLedger(
      [
        tx({ id: "b1", type: "Buy", quantity: 100, price: 10, date: "2023-01-01" }),
        tx({ id: "d1", type: "Dividend", quantity: "2.5", price: 12, date: "2023-06-01" }),
      ],
      { dividendMode: "shares" },
    );

    expect(result.sharesHeld.toFixed()).toBe("102.5");
    // 100*10 + 2.5*12 = 1030
    expect(result.openCostBasis.toFixed()).toBe("1030");
    expect(result.dividendsReceived.toFixed()).toBe("30");
  });

  it("flags zero-cost buys without dividing by zero", () => {
    const result = evaluateFifoLedger([
      tx({ id: "48", type: "Buy", quantity: 1, price: 0, date: "2021-09-20" }),
    ]);

    expect(result.sharesHeld.toFixed()).toBe("1");
    expect(result.openCostBasis.toFixed()).toBe("0");
    expect(result.openLots[0].costPerShare.toFixed()).toBe("0");
    expect(result.zeroCostBuys).toHaveLength(1);
    expect(result.zeroCostBuys[0].transactionId).toBe("48");
  });

  it("uses sourceRowId as tie-breaker for same-second buy+sell pairs", () => {
    // Sell passed first in array, but has higher sourceRowId than Buy at the exact same second
    const result = evaluateFifoLedger([
      tx({ id: "s", type: "Sell", quantity: 5, price: 40, date: "2023-11-06", time: "23:41:00", sourceRowId: 26 }),
      tx({ id: "b", type: "Buy", quantity: 5, price: 38, date: "2023-11-06", time: "23:41:00", sourceRowId: 25 }),
    ]);

    expect(result.sharesHeld.toFixed()).toBe("0");
    expect(result.realizedPnl.toFixed()).toBe("10");
  });

  it("applies stock splits to open lots without altering total lot cost basis", () => {
    const result = evaluateFifoLedger(
      [
        tx({ id: "b1", type: "Buy", quantity: 2, price: 1000, date: "2022-01-10" }),
        tx({ id: "s1", type: "Sell", quantity: 10, price: 120, date: "2022-08-01" }),
      ],
      {
        splits: [
          { id: "sp1", exDate: "2022-07-18", ratioNumerator: 20, ratioDenominator: 1 },
        ],
      },
    );

    // 2 shares @ $1000 ($2000 cost) -> 20:1 split -> 40 shares @ $50 ($2000 cost)
    // Sell 10 @ $120 ($1200 proceeds vs $500 cost = +$700 realized) -> 30 shares left ($1500 cost)
    expect(result.sharesHeld.toFixed()).toBe("30");
    expect(result.openCostBasis.toFixed()).toBe("1500");
    expect(result.openLots[0].costPerShare.toFixed()).toBe("50");
    expect(result.realizedPnl.toFixed()).toBe("700");
  });

  it("locks in historical FX per buy lot when baseCurrency is requested", () => {
    const fxRateBook = new FxRateBook([
      { date: "2023-01-10", fromCurrency: "USD", toCurrency: "SGD", rate: "1.33" },
      { date: "2023-06-10", fromCurrency: "USD", toCurrency: "SGD", rate: "1.35" },
    ]);

    const result = evaluateFifoLedger(
      [
        tx({ id: "b1", type: "Buy", quantity: 10, price: 100, currency: "USD", date: "2023-01-10" }),
        tx({ id: "s1", type: "Sell", quantity: 4, price: 110, currency: "USD", date: "2023-06-10" }),
      ],
      { baseCurrency: "SGD", fxRateBook },
    );

    // Remaining 6 shares * $100 * 1.33 historical FX = 798 SGD
    expect(result.openCostBasisInBase?.toFixed()).toBe("798");
    // Sold 4 shares: cost in SGD = 400 * 1.33 = 532; proceeds in SGD = 440 * 1.35 = 594 -> +62 SGD
    expect(result.realizedPnlInBase?.toFixed()).toBe("62");
  });

  it("rejects oversells and empty Sell All with FifoValidationError", () => {
    expect(() =>
      evaluateFifoLedger([
        tx({ id: "b1", type: "Buy", quantity: 5, price: 100, date: "2023-01-01" }),
        tx({ id: "s1", type: "Sell", quantity: 6, price: 110, date: "2023-02-01" }),
      ]),
    ).toThrow(FifoValidationError);

    expect(() =>
      evaluateFifoLedger([
        tx({ id: "sa", type: "Sell All", quantity: 0, price: 110, date: "2023-02-01" }),
      ]),
    ).toThrow(FifoValidationError);
  });
});

