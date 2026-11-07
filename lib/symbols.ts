/**
 * Ticker and exchange metadata helpers.
 *
 * Maps Yahoo-style symbols (`AAPL`, `ES3.SI`, `^GSPC`, `ETH-SGD`) and CSV
 * exchange short codes (`NMS`, `NYQ`, `PCX`, `SES`, `PNK`, `CCC`, `DJI`, `SNP`,
 * `NIM`) to sensible defaults for currency, exchange code, and asset class.
 *
 * Symbol case is always preserved as entered (trimmed only).
 */

export type AssetClass =
  | "stock"
  | "etf"
  | "reit"
  | "index"
  | "crypto"
  | "unknown";

export interface InferredInstrumentMetadata {
  symbol: string;
  exchangeCode: string | null;
  currency: string;
  assetType: AssetClass;
}

const CRYPTO_EXCHANGES = new Set(["CCC", "CRYPTOCOMPARE"]);
const INDEX_EXCHANGES = new Set(["DJI", "SNP", "NIM", "SES_INDEX"]);
const SGX_EXCHANGES = new Set(["SES", "SGX"]);

const KNOWN_ETFS = new Set([
  "SPY",
  "QQQ",
  "VOO",
  "VTI",
  "IVV",
  "GLD",
  "SLV",
  "JEPI",
  "JEPQ",
  "SCHD",
  "ES3.SI",
  "G3B.SI",
  "CLR.SI",
  "CFA.SI",
  "OVQ.SI",
  "HYDD.SI",
]);

const KNOWN_SGX_REITS = new Set([
  "A17U.SI",
  "C38U.SI",
  "J91U.SI",
  "M44U.SI",
  "ME8U.SI",
  "N2IU.SI",
]);

/**
 * Infers instrument metadata when creating a symbol from manual entry or CSV
 * import, honouring any explicit exchange or currency provided by the caller.
 */
export function inferInstrumentMetadata(params: {
  symbol: string;
  name?: string | null;
  exchangeCode?: string | null;
  currency?: string | null;
  assetType?: AssetClass | null;
}): InferredInstrumentMetadata {
  const symbol = params.symbol.trim();
  const upperSymbol = symbol.toUpperCase();
  const rawExchange = params.exchangeCode?.trim() || null;
  const upperExchange = rawExchange ? rawExchange.toUpperCase() : null;
  const lowerName = (params.name ?? "").toLowerCase();

  // 1. Determine currency
  let currency = params.currency?.trim().toUpperCase() || "";
  if (!currency) {
    if (upperSymbol.endsWith(".SI") || upperSymbol === "^STI") {
      currency = "SGD";
    } else if (upperSymbol.endsWith("-SGD")) {
      currency = "SGD";
    } else if (upperExchange && SGX_EXCHANGES.has(upperExchange)) {
      currency = "SGD";
    } else {
      currency = "USD";
    }
  }

  // 2. Determine exchange code
  let exchangeCode = rawExchange;
  if (!exchangeCode && upperSymbol.endsWith(".SI")) {
    exchangeCode = "SES";
  }

  // 3. Determine asset type
  let assetType: AssetClass = params.assetType ?? "unknown";
  if (assetType === "unknown") {
    if (
      upperSymbol.startsWith("^") ||
      (upperExchange !== null && INDEX_EXCHANGES.has(upperExchange))
    ) {
      assetType = "index";
    } else if (
      (upperExchange !== null && CRYPTO_EXCHANGES.has(upperExchange)) ||
      /^[A-Z0-9]{2,10}-(USD|SGD)$/.test(upperSymbol)
    ) {
      assetType = "crypto";
    } else if (KNOWN_ETFS.has(upperSymbol) || /\betf\b/.test(lowerName)) {
      assetType = "etf";
    } else if (
      KNOWN_SGX_REITS.has(upperSymbol) ||
      /\breit\b/.test(lowerName) ||
      upperExchange === "PCX"
    ) {
      assetType = upperExchange === "PCX" ? "etf" : "reit";
    } else if (exchangeCode !== null || /^[A-Z0-9.]+$/.test(upperSymbol)) {
      assetType = "stock";
    }
  }

  return {
    symbol,
    exchangeCode,
    currency,
    assetType,
  };
}

