/**
 * Deterministic deduplication hash for transactions.
 *
 * Per section 7.5, duplicate detection hashes the canonical tuple:
 *   (portfolioName, symbol, type, quantity, price, executedAt ISO instant)
 *
 * Quantities and prices are canonicalized through FinanceDecimal so `"50.50"`
 * and `"50.5"` produce the exact same hash.
 */
import { createHash } from "node:crypto";
import { type DecimalInput, toDecimal, toDecimalString } from "@/lib/finance/decimal";

export interface DedupeHashInput {
  portfolioName: string;
  symbol: string;
  type: string;
  quantity: DecimalInput;
  price: DecimalInput;
  executedAt: Date;
}

export function computeTransactionDedupeHash(input: DedupeHashInput): string {
  const canonicalQuantity = toDecimalString(toDecimal(input.quantity), 12);
  const canonicalPrice = toDecimalString(toDecimal(input.price), 12);
  const canonicalPayload = [
    input.portfolioName.trim(),
    input.symbol.trim(),
    input.type.trim(),
    canonicalQuantity,
    canonicalPrice,
    input.executedAt.toISOString(),
  ].join("|");

  return createHash("sha256").update(canonicalPayload).digest("hex");
}

