import { describe, expect, it } from "vitest";
import {
  computeCommissionAmount,
  parseCommissionInput,
} from "@/lib/finance/commission";
import {
  formatInstantInOffset,
  parseDateAndTimeWithOffset,
} from "@/lib/finance/date";
import { toDecimal } from "@/lib/finance/decimal";
import { computeTransactionDedupeHash } from "@/lib/finance/dedupe";

describe("commission parsing and math", () => {
  it("treats blank or zero commissions as zero", () => {
    expect(parseCommissionInput("").value.toFixed()).toBe("0");
    expect(parseCommissionInput(null).value.toFixed()).toBe("0");
    expect(parseCommissionInput("0").value.toFixed()).toBe("0");
  });

  it("parses fixed currency commissions", () => {
    const parsed = parseCommissionInput("1.14");
    expect(parsed.raw).toBe("1.14");
    expect(parsed.isPercent).toBe(false);
    expect(
      computeCommissionAmount(toDecimal("500"), parsed).toFixed(),
    ).toBe("1.14");
  });

  it("parses percentage commissions and multiplies by gross trade value", () => {
    const parsed = parseCommissionInput("1%");
    expect(parsed.raw).toBe("1%");
    expect(parsed.isPercent).toBe(true);
    // 340 shares * 0.919 SGD = 312.46 SGD; 1% = 3.1246 SGD (real CFA.SI row 169)
    const gross = toDecimal("340").mul(toDecimal("0.919"));
    expect(computeCommissionAmount(gross, parsed).toFixed()).toBe("3.1246");
  });

  it("rejects negative or non-numeric commissions", () => {
    expect(() => parseCommissionInput("-2")).toThrow(/negative/i);
    expect(() => parseCommissionInput("abc")).toThrow(/invalid commission/i);
  });
});

describe("offset-preserving timestamps", () => {
  it("round-trips CSV date + time with GMT+0800 offset identically", () => {
    const parsed = parseDateAndTimeWithOffset(
      "2021-11-03 GMT+0800",
      "08:13:00",
    );
    expect(parsed.executedAt.toISOString()).toBe("2021-11-03T00:13:00.000Z");
    expect(parsed.originalOffset).toBe("+0800");

    const formatted = formatInstantInOffset(
      parsed.executedAt,
      parsed.originalOffset,
    );
    expect(formatted.csvDate).toBe("2021-11-03 GMT+0800");
    expect(formatted.localTime).toBe("08:13:00");
  });

  it("preserves negative offsets across midnight UTC boundaries", () => {
    const parsed = parseDateAndTimeWithOffset(
      "2023-06-15 GMT-0400",
      "21:45:10",
    );
    expect(parsed.executedAt.toISOString()).toBe("2023-06-16T01:45:10.000Z");

    const formatted = formatInstantInOffset(parsed.executedAt, "-0400");
    expect(formatted.csvDate).toBe("2023-06-15 GMT-0400");
    expect(formatted.localTime).toBe("21:45:10");
  });

  it("rejects impossible calendar dates", () => {
    expect(() => parseDateAndTimeWithOffset("2023-02-29", "10:00:00")).toThrow(
      /does not exist/i,
    );
  });
});

describe("transaction deduplication hash", () => {
  it("produces identical hashes for numerically equal decimals", () => {
    const executedAt = new Date("2021-11-03T00:13:00.000Z");
    const first = computeTransactionDedupeHash({
      portfolioName: "US Stocks",
      symbol: "INTC",
      type: "Buy",
      quantity: "5",
      price: "50.5800",
      executedAt,
    });
    const second = computeTransactionDedupeHash({
      portfolioName: "US Stocks",
      symbol: "INTC",
      type: "Buy",
      quantity: 5,
      price: 50.58,
      executedAt,
    });
    expect(first).toBe(second);
  });
});

