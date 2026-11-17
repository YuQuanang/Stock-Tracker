/**
 * Pure state transitions and exact-decimal math for the New / Edit Transaction
 * form.
 *
 * Keeping these rules in a plain TypeScript module makes every invariant
 * (two-way field linking, clearing mismatched fields on edit, exact-decimal
 * SGD cost calculation, manual price/rate flags, and backdating resets)
 * deterministic and unit-testable.
 */
import {
  isStrictlyPositive,
  toDecimal,
  toDecimalString,
} from "@/lib/finance/decimal";
import type { SymbolSearchMatch } from "@/lib/market-data/search";

export type StockSelectionState = "empty" | "unverified" | "verified";

export interface LinkedStockFormState {
  symbol: string;
  instrumentName: string;
  exchangeCode: string;
  exchangeDisplay: string;
  currency: "USD" | "SGD";
  selectionState: StockSelectionState;
  symbolValidationError: string | null;

  price: string;
  priceAsOf: string | null;
  priceStatus: string | null;
  priceFreshnessLabel: string | null;
  isManualPrice: boolean;
  priceError: string | null;

  fxRateToSgd: string;
  fxAsOf: string | null;
  fxSource: string | null;
  fxLabel: string | null;
  isManualFxRate: boolean;
  fxError: string | null;
}

/**
 * Returns the current date (`YYYY-MM-DD`) and wall-clock time (`HH:MM:SS`) in
 * `Asia/Singapore` (UTC+8).
 */
export function getCurrentSingaporeDateTime(now: Date = new Date()): {
  date: string;
  time: string;
} {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(now);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const year = byType.get("year") ?? "2026";
  const month = byType.get("month") ?? "01";
  const day = byType.get("day") ?? "01";
  const hour = byType.get("hour") ?? "00";
  const minute = byType.get("minute") ?? "00";
  const second = byType.get("second") ?? "00";

  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}:${second}`,
  };
}

export interface ExistingTransactionStockSnapshot {
  symbol: string;
  instrumentName: string | null;
  exchangeCode: string | null;
  currency: string;
  price: string;
  purchaseFxRate: string | null;
  priceAsOf?: string | null;
  priceStatus?: string | null;
  fxRateToSgd?: string | null;
  fxAsOf?: string | null;
  fxSource?: string | null;
  isManualPrice?: boolean;
  isManualFxRate?: boolean;
}

/**
 * Strips leading Yahoo/MSP index caret markers (`^DJI` -> `DJI`) for clean
 * Apple-style display while preserving the canonical database symbol for links
 * and market-data lookups.
 */
export function formatSymbolForDisplay(symbol: string): string {
  const trimmed = symbol.trim();
  if (trimmed.startsWith("^")) {
    return trimmed.slice(1);
  }
  return trimmed;
}

export function formatExchangeCodeForDisplay(
  exchangeCode: string | null | undefined,
): string {
  const normalized = (exchangeCode ?? "").trim().toUpperCase();
  if (!normalized) {
    return "";
  }
  if (normalized === "SES" || normalized === "SGX") {
    return "SGX";
  }
  if (
    normalized === "LSE" ||
    normalized === "LON" ||
    normalized === "IOB" ||
    normalized === "XLON"
  ) {
    return "LSE";
  }
  if (normalized === "NMS" || normalized === "NGM" || normalized === "NCM") {
    return "NASDAQ";
  }
  if (normalized === "NYQ") {
    return "NYSE";
  }
  if (normalized === "PCX") {
    return "NYSE Arca";
  }
  if (normalized === "ASE") {
    return "NYSE American";
  }
  if (
    normalized === "DJI" ||
    normalized === "SNP" ||
    normalized === "NIM" ||
    normalized === "INDEX"
  ) {
    return "INDEX";
  }
  return normalized;
}

export function createInitialLinkedStockState(): LinkedStockFormState {
  return {
    symbol: "",
    instrumentName: "",
    exchangeCode: "",
    exchangeDisplay: "",
    currency: "USD",
    selectionState: "empty",
    symbolValidationError: null,

    price: "",
    priceAsOf: null,
    priceStatus: null,
    priceFreshnessLabel: null,
    isManualPrice: false,
    priceError: null,

    fxRateToSgd: "",
    fxAsOf: null,
    fxSource: null,
    fxLabel: null,
    isManualFxRate: false,
    fxError: null,
  };
}

export function createLinkedStockStateFromExisting(
  row: ExistingTransactionStockSnapshot,
): LinkedStockFormState {
  const currency: "USD" | "SGD" = row.currency === "SGD" ? "SGD" : "USD";
  const effectiveFxRate =
    row.fxRateToSgd ?? row.purchaseFxRate ?? (currency === "SGD" ? "1" : "");
  const isManualPrice = Boolean(row.isManualPrice);
  const isManualFxRate = Boolean(row.isManualFxRate);

  let fxLabel: string | null = null;
  if (isManualFxRate) {
    fxLabel = "Manual rate";
  } else if (currency === "SGD") {
    fxLabel = "Priced in SGD (1:1)";
  } else if (row.fxSource) {
    fxLabel = `Saved ${row.fxSource} snapshot`;
  }

  return {
    symbol: row.symbol,
    instrumentName: row.instrumentName ?? "",
    exchangeCode: row.exchangeCode ?? "",
    exchangeDisplay: formatExchangeCodeForDisplay(row.exchangeCode),
    currency,
    selectionState: "verified",
    symbolValidationError: null,

    price: row.price,
    priceAsOf: row.priceAsOf ?? null,
    priceStatus: row.priceStatus ?? null,
    priceFreshnessLabel: isManualPrice ? "Manual price" : null,
    isManualPrice,
    priceError: null,

    fxRateToSgd: effectiveFxRate,
    fxAsOf: row.fxAsOf ?? null,
    fxSource: row.fxSource ?? (currency === "SGD" ? "native-sgd" : null),
    fxLabel,
    isManualFxRate,
    fxError: null,
  };
}

/**
 * Rule 9: Selecting an item from either dropdown fills BOTH Symbol and Company
 * Name (plus exchange & currency) with the official API values, and resets
 * stale price/FX fields before the parallel quote + FX fetch begins.
 */
export function applyStockSelection(
  previous: LinkedStockFormState,
  match: SymbolSearchMatch,
  nowIso: string = new Date().toISOString(),
): LinkedStockFormState {
  const isSgd = match.currency === "SGD";
  return {
    ...previous,
    symbol: match.symbol,
    instrumentName: match.name,
    exchangeCode: match.exchangeCode,
    exchangeDisplay: match.exchangeDisplay,
    currency: match.currency,
    selectionState: "verified",
    symbolValidationError: null,

    // Clear previous stock's price while fetching the newly selected stock
    price: "",
    priceAsOf: null,
    priceStatus: null,
    priceFreshnessLabel: null,
    isManualPrice: false,
    priceError: null,

    // Rule 14: If priced in SGD, immediately lock rate = 1 and skip FX fetch
    fxRateToSgd: isSgd ? "1" : "",
    fxAsOf: isSgd ? nowIso : null,
    fxSource: isSgd ? "native-sgd" : null,
    fxLabel: isSgd ? "Priced in SGD (1:1)" : null,
    isManualFxRate: false,
    fxError: null,
  };
}

/**
 * Rule 11: If the user edits the Symbol field after a selection, clear the
 * Company Name field, exchange, and auto-filled price/FX so the form can never
 * hold a mismatched symbol and company name.
 */
export function applySymbolInputEdit(
  previous: LinkedStockFormState,
  nextSymbol: string,
): LinkedStockFormState {
  const wasLinked =
    previous.selectionState === "verified" || previous.instrumentName !== "";

  return {
    ...previous,
    symbol: nextSymbol,
    instrumentName: wasLinked ? "" : previous.instrumentName,
    exchangeCode: "",
    exchangeDisplay: "",
    selectionState: nextSymbol.trim() === "" ? "empty" : "unverified",
    symbolValidationError: null,

    price: wasLinked && !previous.isManualPrice ? "" : previous.price,
    priceAsOf: null,
    priceStatus: previous.isManualPrice ? "manual" : null,
    priceFreshnessLabel: null,
    priceError: null,

    fxRateToSgd: wasLinked && !previous.isManualFxRate ? "" : previous.fxRateToSgd,
    fxAsOf: null,
    fxSource: previous.isManualFxRate ? "manual" : null,
    fxLabel: null,
    fxError: null,
  };
}

/**
 * Rule 11 (mirror): If the user edits the Company Name field after a selection,
 * clear the Symbol field, exchange, and auto-filled price/FX.
 */
export function applyCompanyNameInputEdit(
  previous: LinkedStockFormState,
  nextCompanyName: string,
): LinkedStockFormState {
  const wasLinked =
    previous.selectionState === "verified" || previous.symbol !== "";

  return {
    ...previous,
    symbol: wasLinked ? "" : previous.symbol,
    instrumentName: nextCompanyName,
    exchangeCode: "",
    exchangeDisplay: "",
    selectionState: nextCompanyName.trim() === "" ? "empty" : "unverified",
    symbolValidationError: null,

    price: wasLinked && !previous.isManualPrice ? "" : previous.price,
    priceAsOf: null,
    priceStatus: previous.isManualPrice ? "manual" : null,
    priceFreshnessLabel: null,
    priceError: null,

    fxRateToSgd: wasLinked && !previous.isManualFxRate ? "" : previous.fxRateToSgd,
    fxAsOf: null,
    fxSource: previous.isManualFxRate ? "manual" : null,
    fxLabel: null,
    fxError: null,
  };
}

/** Marks the price field as manually edited by the user (Rule 13 & 20). */
export function applyManualPriceEdit(
  previous: LinkedStockFormState,
  nextPrice: string,
): LinkedStockFormState {
  return {
    ...previous,
    price: nextPrice,
    priceAsOf: null,
    priceStatus: nextPrice.trim() !== "" ? "manual" : null,
    priceFreshnessLabel: null,
    isManualPrice: nextPrice.trim() !== "",
    priceError: null,
  };
}

/** Marks the exchange-rate field as manually overridden by the user (Rule 15 & 20). */
export function applyManualFxRateEdit(
  previous: LinkedStockFormState,
  nextRate: string,
): LinkedStockFormState {
  return {
    ...previous,
    fxRateToSgd: nextRate,
    fxAsOf: nextRate.trim() !== "" ? new Date().toISOString() : null,
    fxSource: nextRate.trim() !== "" ? "manual" : null,
    fxLabel: nextRate.trim() !== "" ? "Manual rate" : null,
    isManualFxRate: nextRate.trim() !== "",
    fxError: null,
  };
}

/**
 * Rule 16: Clears stale auto-filled price/FX immediately when the user changes
 * the transaction date so today's values are never silently kept on a backdated
 * transaction while historical quotes/FX are loading.
 */
export function clearAutoFilledForDateChange(
  previous: LinkedStockFormState,
  newDate: string,
): LinkedStockFormState {
  const isSgd = previous.currency === "SGD";
  return {
    ...previous,
    price: previous.isManualPrice ? previous.price : "",
    priceAsOf: previous.isManualPrice ? previous.priceAsOf : null,
    priceStatus: previous.isManualPrice ? "manual" : null,
    priceFreshnessLabel: null,
    priceError: null,

    fxRateToSgd: isSgd
      ? "1"
      : previous.isManualFxRate
        ? previous.fxRateToSgd
        : "",
    fxAsOf: isSgd
      ? `${newDate}T00:00:00.000Z`
      : previous.isManualFxRate
        ? previous.fxAsOf
        : null,
    fxSource: isSgd
      ? "native-sgd"
      : previous.isManualFxRate
        ? "manual"
        : null,
    fxLabel: isSgd
      ? "Priced in SGD (1:1)"
      : previous.isManualFxRate
        ? "Manual rate"
        : null,
    fxError: null,
  };
}

const VALID_DECIMAL_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/**
 * Rule 14, 15, 19: Computes exact SGD total (`quantity * price * fxRateToSgd`
 * for share trades, or `quantity * fxRateToSgd` for cash dividends) using
 * 40-digit Decimal arithmetic — never binary floating point.
 *
 * Returns `null` when any required input is missing or non-positive.
 */
export function computeTransactionSgdTotal(params: {
  type: "Buy" | "Sell" | "Sell All" | "Dividend";
  quantity: string;
  price: string;
  fxRateToSgd: string;
  /** Optional currently held shares used to preview `Sell All` totals. */
  openShares?: string | null;
}): {
  nativeGross: string;
  totalSgd: string;
} | null {
  const qtyTrimmed =
    params.type === "Sell All"
      ? (params.openShares ?? "").trim()
      : params.quantity.trim();
  const priceTrimmed = params.price.trim();
  const rateTrimmed = params.fxRateToSgd.trim();

  if (!VALID_DECIMAL_PATTERN.test(rateTrimmed)) {
    return null;
  }
  const rate = toDecimal(rateTrimmed);
  if (!isStrictlyPositive(rate)) {
    return null;
  }

  if (!VALID_DECIMAL_PATTERN.test(qtyTrimmed)) {
    return null;
  }
  const qty = toDecimal(qtyTrimmed);
  if (!isStrictlyPositive(qty)) {
    return null;
  }

  if (params.type === "Dividend") {
    const totalSgd = qty.mul(rate);
    return {
      nativeGross: toDecimalString(qty, 6),
      totalSgd: toDecimalString(totalSgd, 4),
    };
  }

  if (!VALID_DECIMAL_PATTERN.test(priceTrimmed)) {
    return null;
  }
  const price = toDecimal(priceTrimmed);
  if (price.isNegative()) {
    return null;
  }

  const nativeGross = qty.mul(price);
  const totalSgd = nativeGross.mul(rate);
  return {
    nativeGross: toDecimalString(nativeGross, 6),
    totalSgd: toDecimalString(totalSgd, 4),
  };
}
