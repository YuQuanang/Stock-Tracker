/**
 * Commission parsing and calculation.
 *
 * In Microsoft Start / MSN Money exports (and in manual entry), a commission
 * can be either:
 *   - an absolute currency amount such as `"1.14"` or `"47.463"`, or
 *   - a percentage of the gross trade value such as `"1%"`.
 *
 * We keep the original raw string so CSV round-trip export is byte-for-byte
 * identical, alongside the parsed numeric value and a boolean flag.
 */
import {
  type DecimalValue,
  HUNDRED,
  toDecimal,
  ZERO,
} from "@/lib/finance/decimal";

export interface ParsedCommission {
  /** Original input string (trimmed), or null when left blank. */
  raw: string | null;
  /** Numeric value: e.g. `1.14` for `"1.14"`, or `1` for `"1%"`. */
  value: DecimalValue;
  /** True when the commission represents a percentage of gross trade value. */
  isPercent: boolean;
}

/**
 * Parses a raw commission string such as `""`, `"0"`, `"1.14"`, or `"1%"`.
 * Throws a descriptive Error if the text is negative or not a valid number.
 */
export function parseCommissionInput(
  rawInput: string | null | undefined,
): ParsedCommission {
  if (rawInput === null || rawInput === undefined) {
    return {
      raw: null,
      value: ZERO,
      isPercent: false,
    };
  }

  const trimmed = rawInput.trim();
  if (trimmed === "") {
    return {
      raw: null,
      value: ZERO,
      isPercent: false,
    };
  }

  const isPercent = trimmed.endsWith("%");
  const numericPortion = isPercent ? trimmed.slice(0, -1).trim() : trimmed;

  if (numericPortion === "" || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(numericPortion)) {
    throw new Error(`Invalid commission "${rawInput}". Enter a number like 1.14 or a percentage like 1%.`);
  }

  const parsedValue = toDecimal(numericPortion);
  if (parsedValue.isNegative()) {
    throw new Error(`Commission cannot be negative (received "${rawInput}").`);
  }

  return {
    raw: trimmed,
    value: parsedValue,
    isPercent,
  };
}

/**
 * Computes the commission in the transaction's native currency.
 *
 * Formula in words:
 *   - Percentage commission: grossTradeAmount * (commissionPercent / 100).
 *   - Absolute commission:   commissionValue directly.
 */
export function computeCommissionAmount(
  grossTradeAmount: DecimalValue,
  commission: Pick<ParsedCommission, "value" | "isPercent">,
): DecimalValue {
  if (commission.value.isZero()) {
    return ZERO;
  }

  if (commission.isPercent) {
    return grossTradeAmount.mul(commission.value).div(HUNDRED);
  }

  return commission.value;
}

