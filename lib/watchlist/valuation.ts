/**
 * Watchlist Valuation & "If I Had Bought It" Paper-Position Simulator Math.
 *
 * All money, share counts, alert comparisons, and benchmark differences run
 * through Decimal.js (`FinanceDecimal`) so binary floating-point rounding never
 * drifts share counts or percentage returns.
 *
 * Safe for both Server Components/services and Client Components (imports only
 * pure Decimal helpers and TypeScript types).
 */
import {
  HUNDRED,
  isStrictlyPositive,
  ONE,
  safeDivide,
  toDecimal,
  toDecimalString,
  toOptionalDecimal,
  ZERO,
} from "@/lib/finance/decimal";
import type { ResolvedInstrumentQuote } from "@/lib/market-data/batch-quotes";

export type AlertState = "triggered-above" | "triggered-below" | "armed" | "none";

export interface PaperBenchmarkComparison {
  benchmarkSymbol: string;
  benchmarkName: string;
  entryDate: string;
  entryPrice: string;
  currentPrice: string;
  benchmarkShares: string;
  benchmarkValue: string;
  benchmarkGain: string;
  benchmarkGainPercent: string;
}

export interface SerializedWatchlistItem {
  portfolioId: string;
  portfolioName: string;
  instrumentId: string;
  symbol: string;
  name: string | null;
  exchangeCode: string | null;
  currency: "USD" | "SGD";
  assetType: string;
  priceNotFound?: boolean;
  priceNotFoundReason?: string | null;
  sortOrder: number;
  dateAdded: string | null;
  priceWhenAdded: string | null;
  alertAbove: string | null;
  alertBelow: string | null;
  paperEntryDate: string | null;
  paperAmount: string | null;
  paperShares: string | null;
  fiftyTwoWeekLow: string | null;
  fiftyTwoWeekHigh: string | null;
  paperBenchmark: PaperBenchmarkComparison | null;
}

export interface ValuedWatchlistItem extends SerializedWatchlistItem {
  unitPrice: string | null;
  previousClose: string | null;
  dayChange: string | null;
  dayChangePercent: string | null;
  sinceAddedChange: string | null;
  sinceAddedPercent: string | null;
  range52wPercent: number | null;
  alertState: AlertState;
  paperEntryPriceImplied: string | null;
  paperCurrentValue: string | null;
  paperGain: string | null;
  paperGainPercent: string | null;
  paperCurrentValueBase: string | null;
  paperExcessReturnPercent: string | null;
  sparkline: string[];
  freshnessLabel: string;
  priceStatus: ResolvedInstrumentQuote["status"];
  source: ResolvedInstrumentQuote["source"];
  isAvailable: boolean;
  isPriceNotFound: boolean;
  unavailableReason: string | null;
}

export interface PaperComparisonInput {
  amount: string;
  assetEntryPrice: string;
  assetCurrentPrice: string;
  benchmarkEntryPrice?: string | null;
  benchmarkCurrentPrice?: string | null;
}

export interface PaperComparisonResult {
  paperShares: string;
  assetEntryPrice: string;
  assetCurrentPrice: string;
  assetCurrentValue: string;
  assetGain: string;
  assetGainPercent: string;
  benchmarkShares: string | null;
  benchmarkValue: string | null;
  benchmarkGain: string | null;
  benchmarkGainPercent: string | null;
  excessReturnPercent: string | null;
}

/**
 * Computes how an equal-dollar investment made on `entryDate` would have
 * performed in the target stock compared against a benchmark index.
 *
 * Formulas:
 * - paperShares = amount / assetEntryPrice
 * - assetCurrentValue = paperShares * assetCurrentPrice
 * - assetGain = assetCurrentValue - amount
 * - assetGainPercent = (assetGain / amount) * 100
 * - benchmarkShares = amount / benchmarkEntryPrice
 * - benchmarkValue = benchmarkShares * benchmarkCurrentPrice
 * - benchmarkGain = benchmarkValue - amount
 * - benchmarkGainPercent = (benchmarkGain / amount) * 100
 * - excessReturnPercent = assetGainPercent - benchmarkGainPercent
 */
export function computePaperComparison(
  input: PaperComparisonInput,
): PaperComparisonResult | null {
  const amount = toOptionalDecimal(input.amount);
  const assetEntryPrice = toOptionalDecimal(input.assetEntryPrice);
  const assetCurrentPrice = toOptionalDecimal(input.assetCurrentPrice);

  if (
    !amount ||
    !assetEntryPrice ||
    !assetCurrentPrice ||
    !isStrictlyPositive(amount) ||
    !isStrictlyPositive(assetEntryPrice)
  ) {
    return null;
  }

  const paperShares = safeDivide(amount, assetEntryPrice);
  if (!paperShares) {
    return null;
  }

  const assetCurrentValue = paperShares.mul(assetCurrentPrice);
  const assetGain = assetCurrentValue.minus(amount);
  const assetGainPercent = assetGain.div(amount).mul(HUNDRED);

  let benchmarkSharesStr: string | null = null;
  let benchmarkValueStr: string | null = null;
  let benchmarkGainStr: string | null = null;
  let benchmarkGainPercentStr: string | null = null;
  let excessReturnPercentStr: string | null = null;

  const benchmarkEntryPrice = toOptionalDecimal(input.benchmarkEntryPrice);
  const benchmarkCurrentPrice = toOptionalDecimal(input.benchmarkCurrentPrice);

  if (
    benchmarkEntryPrice &&
    benchmarkCurrentPrice &&
    isStrictlyPositive(benchmarkEntryPrice)
  ) {
    const benchmarkShares = safeDivide(amount, benchmarkEntryPrice);
    if (benchmarkShares) {
      const benchmarkValue = benchmarkShares.mul(benchmarkCurrentPrice);
      const benchmarkGain = benchmarkValue.minus(amount);
      const benchmarkGainPercent = benchmarkGain.div(amount).mul(HUNDRED);
      const excessReturnPercent = assetGainPercent.minus(benchmarkGainPercent);

      benchmarkSharesStr = toDecimalString(benchmarkShares, 8);
      benchmarkValueStr = toDecimalString(benchmarkValue, 6);
      benchmarkGainStr = toDecimalString(benchmarkGain, 6);
      benchmarkGainPercentStr = toDecimalString(benchmarkGainPercent, 6);
      excessReturnPercentStr = toDecimalString(excessReturnPercent, 6);
    }
  }

  return {
    paperShares: toDecimalString(paperShares, 8),
    assetEntryPrice: toDecimalString(assetEntryPrice, 6),
    assetCurrentPrice: toDecimalString(assetCurrentPrice, 6),
    assetCurrentValue: toDecimalString(assetCurrentValue, 6),
    assetGain: toDecimalString(assetGain, 6),
    assetGainPercent: toDecimalString(assetGainPercent, 6),
    benchmarkShares: benchmarkSharesStr,
    benchmarkValue: benchmarkValueStr,
    benchmarkGain: benchmarkGainStr,
    benchmarkGainPercent: benchmarkGainPercentStr,
    excessReturnPercent: excessReturnPercentStr,
  };
}

/**
 * Evaluates whether the live/last-close unit price triggers either price alert.
 *
 * Rules:
 * - `"triggered-above"` when `unitPrice >= alertAbove`
 * - `"triggered-below"` when `unitPrice <= alertBelow`
 * - `"armed"` when at least one alert threshold is configured and neither fired
 * - `"none"` when no alert thresholds are set
 */
export function evaluatePriceAlert(
  unitPrice: string | null,
  alertAbove: string | null,
  alertBelow: string | null,
): AlertState {
  const above = toOptionalDecimal(alertAbove);
  const below = toOptionalDecimal(alertBelow);
  const hasAny = Boolean(above || below);

  if (!hasAny) {
    return "none";
  }

  const price = toOptionalDecimal(unitPrice);
  if (!price) {
    return "armed";
  }

  if (above && price.gte(above)) {
    return "triggered-above";
  }
  if (below && price.lte(below)) {
    return "triggered-below";
  }

  return "armed";
}

/**
 * Computes the relative position (0..100) of `unitPrice` inside the 52-week
 * low-to-high range bar:
 * `percent = ((unitPrice - low) / (high - low)) * 100`, clamped to `[0, 100]`.
 */
export function compute52WeekRangePercent(
  unitPrice: string | null,
  fiftyTwoWeekLow: string | null,
  fiftyTwoWeekHigh: string | null,
): number | null {
  const price = toOptionalDecimal(unitPrice);
  const low = toOptionalDecimal(fiftyTwoWeekLow);
  const high = toOptionalDecimal(fiftyTwoWeekHigh);

  if (!price || !low || !high) {
    return null;
  }

  const span = high.minus(low);
  if (!isStrictlyPositive(span)) {
    return null;
  }

  const rawPercent = price.minus(low).div(span).mul(HUNDRED).toNumber();
  if (!Number.isFinite(rawPercent)) {
    return null;
  }

  return Math.max(0, Math.min(100, rawPercent));
}

function convertAmountToBaseCurrency(
  amount: string,
  fromCurrency: "USD" | "SGD",
  baseCurrency: "SGD" | "USD",
  usdToSgdRate: string | null,
): string | null {
  if (fromCurrency === baseCurrency) {
    return amount;
  }

  const rate = toOptionalDecimal(usdToSgdRate);
  if (!rate || !isStrictlyPositive(rate)) {
    return null;
  }

  const val = toDecimal(amount);
  if (fromCurrency === "USD" && baseCurrency === "SGD") {
    return toDecimalString(val.mul(rate), 6);
  }
  if (fromCurrency === "SGD" && baseCurrency === "USD") {
    return toDecimalString(val.div(rate), 6);
  }
  return toDecimalString(val.mul(ONE), 6);
}

/**
 * Combines a stored watchlist item with live/cached quote data to produce all
 * display numbers: day change, since-added return, 52-week range position,
 * alert status, and "If I had bought it" paper-position + benchmark return.
 */
export function computeWatchlistItemValuation(
  item: SerializedWatchlistItem,
  quote: ResolvedInstrumentQuote | undefined,
  usdToSgdRate: string | null,
  baseCurrency: "SGD" | "USD",
): ValuedWatchlistItem {
  const unitPrice = quote?.price ?? null;
  const previousClose = quote?.previousClose ?? null;
  const dayChange = quote?.dayChange ?? null;
  const dayChangePercent = quote?.dayChangePercent ?? null;

  // Since-Added Gain:
  // sinceAddedChange = unitPrice - priceWhenAdded
  // sinceAddedPercent = ((unitPrice - priceWhenAdded) / priceWhenAdded) * 100
  let sinceAddedChange: string | null = null;
  let sinceAddedPercent: string | null = null;
  const currentDec = toOptionalDecimal(unitPrice);
  const addedDec = toOptionalDecimal(item.priceWhenAdded);
  if (currentDec && addedDec && isStrictlyPositive(addedDec)) {
    const diff = currentDec.minus(addedDec);
    const pct = diff.div(addedDec).mul(HUNDRED);
    sinceAddedChange = toDecimalString(diff, 6);
    sinceAddedPercent = toDecimalString(pct, 6);
  }

  const range52wPercent = compute52WeekRangePercent(
    unitPrice,
    item.fiftyTwoWeekLow,
    item.fiftyTwoWeekHigh,
  );

  const alertState = evaluatePriceAlert(
    unitPrice,
    item.alertAbove,
    item.alertBelow,
  );

  // Paper Position ("If I had bought it"):
  // paperCurrentValue = paperShares * unitPrice
  // paperGain = paperCurrentValue - paperAmount
  // paperGainPercent = (paperGain / paperAmount) * 100
  // paperExcessReturnPercent = paperGainPercent - paperBenchmark.benchmarkGainPercent
  const paperAmountDec = toOptionalDecimal(item.paperAmount);
  const paperSharesDec = toOptionalDecimal(item.paperShares);
  let paperEntryPriceImplied: string | null = null;
  let paperCurrentValue: string | null = null;
  let paperGain: string | null = null;
  let paperGainPercent: string | null = null;
  let paperCurrentValueBase: string | null = null;
  let paperExcessReturnPercent: string | null = null;

  if (
    paperAmountDec &&
    paperSharesDec &&
    isStrictlyPositive(paperAmountDec) &&
    isStrictlyPositive(paperSharesDec)
  ) {
    const impliedEntry = safeDivide(paperAmountDec, paperSharesDec);
    if (impliedEntry) {
      paperEntryPriceImplied = toDecimalString(impliedEntry, 6);
    }

    if (currentDec && currentDec.gte(ZERO)) {
      const value = paperSharesDec.mul(currentDec);
      const gain = value.minus(paperAmountDec);
      const gainPct = gain.div(paperAmountDec).mul(HUNDRED);

      paperCurrentValue = toDecimalString(value, 6);
      paperGain = toDecimalString(gain, 6);
      paperGainPercent = toDecimalString(gainPct, 6);
      paperCurrentValueBase = convertAmountToBaseCurrency(
        paperCurrentValue,
        item.currency,
        baseCurrency,
        usdToSgdRate,
      );

      if (item.paperBenchmark?.benchmarkGainPercent) {
        const benchPct = toDecimal(item.paperBenchmark.benchmarkGainPercent);
        paperExcessReturnPercent = toDecimalString(gainPct.minus(benchPct), 6);
      }
    }
  }

  const isPriceNotFound = Boolean(
    !(quote?.price && quote.status !== "unavailable") &&
      item.assetType !== "crypto" &&
      (item.priceNotFound || quote?.priceNotFound),
  );

  return {
    ...item,
    unitPrice,
    previousClose,
    dayChange,
    dayChangePercent,
    sinceAddedChange,
    sinceAddedPercent,
    range52wPercent,
    alertState,
    paperEntryPriceImplied,
    paperCurrentValue,
    paperGain,
    paperGainPercent,
    paperCurrentValueBase,
    paperExcessReturnPercent,
    sparkline: quote?.sparklineCloses ?? [],
    freshnessLabel:
      quote?.freshnessLabel ??
      (isPriceNotFound ? "Price not found" : "Price unavailable"),
    priceStatus: quote?.status ?? "unavailable",
    source: quote?.source ?? "unavailable",
    isAvailable: Boolean(quote?.price && quote.status !== "unavailable"),
    isPriceNotFound,
    unavailableReason:
      quote?.unavailableReason ?? item.priceNotFoundReason ?? null,
  };
}
