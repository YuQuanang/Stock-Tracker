/**
 * Exact decimal arithmetic helpers for all financial calculations.
 *
 * Why Decimal instead of JavaScript `number`:
 * Binary floating-point cannot represent values like `0.1 + 0.2` or `0.919 * 340`
 * accurately, causing penny drift in cost basis and FIFO lot matching. Every
 * quantity, price, commission, FX rate, and P&L value flows through Decimal.
 */
import Decimal from "decimal.js";

/**
 * Configure a dedicated Decimal constructor with 40 significant digits and
 * standard half-up rounding so intermediate divisions (such as pro-rata lot
 * allocation and split adjustments) retain ample precision.
 */
export const FinanceDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
});

export type DecimalValue = InstanceType<typeof FinanceDecimal>;
export type DecimalInput = DecimalValue | string | number;

export const ZERO = new FinanceDecimal(0);
export const ONE = new FinanceDecimal(1);
export const HUNDRED = new FinanceDecimal(100);

/**
 * Tolerance used only when comparing share quantities that passed through a
 * stock split ratio (for example, a 3-for-2 split followed by a sell).
 */
export const QUANTITY_EPSILON = new FinanceDecimal("0.0000000001");

/** Converts a string, number, or Decimal into a configured FinanceDecimal. */
export function toDecimal(value: DecimalInput): DecimalValue {
  if (value instanceof FinanceDecimal) {
    return value;
  }
  if (Decimal.isDecimal(value)) {
    return new FinanceDecimal(value.toString());
  }
  return new FinanceDecimal(value);
}

/** Converts an optional/nullable DB numeric string to FinanceDecimal or null. */
export function toOptionalDecimal(
  value: DecimalInput | null | undefined,
): DecimalValue | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" && value.trim() === "") {
    return null;
  }
  return toDecimal(value);
}

/**
 * Note: in decimal.js, `Decimal(0).isPositive()` is `true` because `+0` has a
 * positive sign bit. Always use `isStrictlyPositive(x)` (or `x.gt(0)`) when
 * checking `x > 0`.
 */
export function isStrictlyPositive(value: DecimalValue): boolean {
  return value.gt(ZERO);
}

/**
 * Divides `numerator` by `denominator`, returning `null` when `denominator` is
 * zero instead of producing `Infinity` or `NaN`.
 *
 * Formula: result = numerator / denominator (when denominator != 0).
 */
export function safeDivide(
  numerator: DecimalValue,
  denominator: DecimalValue,
): DecimalValue | null {
  if (denominator.isZero()) {
    return null;
  }
  return numerator.div(denominator);
}

/**
 * Formats a Decimal as a plain non-exponential string suitable for Drizzle
 * `numeric(38, 12)` columns and JSON API responses, trimming trailing zeros
 * after the decimal point.
 */
export function toDecimalString(
  value: DecimalValue,
  maxFractionDigits: number = 12,
): string {
  const rounded = value.toDecimalPlaces(
    maxFractionDigits,
    FinanceDecimal.ROUND_HALF_UP,
  );
  return rounded.toFixed();
}

/** Formats a nullable Decimal to string or null for JSON serialization. */
export function toNullableDecimalString(
  value: DecimalValue | null,
  maxFractionDigits: number = 12,
): string | null {
  if (value === null) {
    return null;
  }
  return toDecimalString(value, maxFractionDigits);
}
