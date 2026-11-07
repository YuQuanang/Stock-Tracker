/**
 * Row-level and chronological FIFO ledger validation for parsed CSV documents.
 *
 * Produces:
 *  - Validated placeholder rows and transaction rows (with canonical dedupe hashes)
 *  - Per-row errors (with physical line numbers and raw fields for Rejected CSV download)
 *  - Rich preview statistics (counts per portfolio, per type, sample rows,
 *    detected symbols, and non-blocking data-quality warnings)
 */
import {
  applySymbolWideSellAll,
  computeTransactionDedupeHash,
  evaluateFifoLedger,
  FifoValidationError,
  isStrictlyPositive,
  type LedgerTransactionInput,
  parseCommissionInput,
  parseDateAndTimeWithOffset,
  resolveSellAllSourceId,
  toDecimal,
  toDecimalString,
} from "@/lib/finance";
import {
  type DetectedCsvFormat,
  type ParsedCsvDocument,
  type RawParsedCsvRow,
} from "@/lib/csv/msp-parser";
import { type AssetClass, inferInstrumentMetadata } from "@/lib/symbols";

export type ValidTransactionType = "Buy" | "Sell" | "Sell All" | "Dividend";

export interface ValidatedPlaceholderRow {
  kind: "placeholder";
  lineNumber: number;
  sourceRowId: number | null;
  portfolio: string;
  symbol: string;
  /** Exact raw Name from CSV (may be `""` or have trailing spaces). */
  rawName: string;
  rawDisplaySymbol: string;
  rawExchange: string;
  currency: "USD" | "SGD";
  assetType: AssetClass;
}

export interface ValidatedTransactionRow {
  kind: "transaction";
  /** Synthetic validation key (`line-{lineNumber}`) for FIFO error pinpointing. */
  validationKey: string;
  lineNumber: number;
  sourceRowId: number | null;
  portfolio: string;
  symbol: string;
  rawName: string;
  rawDisplaySymbol: string;
  rawExchange: string;
  currency: "USD" | "SGD";
  assetType: AssetClass;
  type: ValidTransactionType;
  quantity: string;
  price: string;
  commissionRaw: string;
  commissionValue: string;
  commissionIsPercent: boolean;
  executedAt: Date;
  originalOffset: string;
  localDate: string;
  localTime: string;
  purchaseFxRate: string | null;
  purchaseFxCurrencies: string | null;
  accounting: string | null;
  accountingExecutionIds: string | null;
  notes: string | null;
  outgoingCashLink: string | null;
  dedupeHash: string;
  rawRow: RawParsedCsvRow;
}

export type ValidatedCsvRow = ValidatedPlaceholderRow | ValidatedTransactionRow;

export interface RejectedCsvRow {
  lineNumber: number;
  sourceRowId: number | null;
  portfolio: string;
  symbol: string;
  type: string;
  reason: string;
  rawFields: string[];
}

export interface PortfolioPreviewSummary {
  name: string;
  inferredType: "holdings" | "watchlist";
  defaultCurrency: "USD" | "SGD";
  symbolCount: number;
  placeholderCount: number;
  transactionCount: number;
  duplicateTransactionCount?: number;
}

export interface CsvWarningItem {
  kind:
    | "zero_cost_buy"
    | "crypto_unpriced"
    | "missing_metadata"
    | "missing_fx";
  message: string;
}

export interface CsvSamplePreviewRow {
  lineNumber: number;
  id: number | null;
  portfolio: string;
  symbol: string;
  name: string;
  kind: "Placeholder" | ValidTransactionType;
  quantity: string;
  price: string;
  currency: string;
  date: string;
}

export interface CsvValidationResult {
  format: DetectedCsvFormat;
  headers: string[];
  totalDataRows: number;
  placeholderCount: number;
  transactionCount: number;
  validRows: ValidatedCsvRow[];
  rejectedRows: RejectedCsvRow[];
  portfolios: PortfolioPreviewSummary[];
  typeCounts: Record<ValidTransactionType, number>;
  detectedSymbols: {
    symbol: string;
    name: string;
    exchange: string;
    currency: "USD" | "SGD";
    assetType: AssetClass;
  }[];
  warnings: CsvWarningItem[];
  sampleRows: CsvSamplePreviewRow[];
}

const VALID_TYPES = new Set<ValidTransactionType>([
  "Buy",
  "Sell",
  "Sell All",
  "Dividend",
]);

const DECIMAL_INPUT_REGEX = /^[+-]?(\d+\.?\d*|\.\d+)$/;

function isValidDecimalText(raw: string): boolean {
  return DECIMAL_INPUT_REGEX.test(raw.trim());
}

/**
 * Validates all rows of a parsed CSV document, including per-symbol currency
 * consistency and chronological FIFO oversell checks per `(portfolio, symbol)`.
 */
export function validateParsedCsv(
  doc: ParsedCsvDocument,
  options: {
    dividendMode?: "cash" | "shares";
    /** Existing symbol -> currency map from the database to catch cross-import mismatches. */
    existingSymbolCurrencies?: ReadonlyMap<string, string>;
  } = {},
): CsvValidationResult {
  const dividendMode = options.dividendMode ?? "cash";
  const symbolCurrencyMap = new Map<string, "USD" | "SGD">();

  if (options.existingSymbolCurrencies) {
    for (const [sym, curr] of options.existingSymbolCurrencies.entries()) {
      if (curr === "USD" || curr === "SGD") {
        symbolCurrencyMap.set(sym, curr);
      }
    }
  }

  const candidateRows: ValidatedCsvRow[] = [];
  const rejectedRows: RejectedCsvRow[] = [];

  for (const raw of doc.rows) {
    const symbol = raw.symbol.trim();
    const portfolio = raw.portfolio.trim();
    const rawType = raw.type.trim();

    if (!symbol) {
      rejectedRows.push({
        lineNumber: raw.lineNumber,
        sourceRowId: raw.sourceRowId,
        portfolio,
        symbol: "",
        type: rawType,
        reason: "Missing Symbol.",
        rawFields: raw.rawFields,
      });
      continue;
    }

    if (!portfolio) {
      rejectedRows.push({
        lineNumber: raw.lineNumber,
        sourceRowId: raw.sourceRowId,
        portfolio: "",
        symbol,
        type: rawType,
        reason: `Missing Portfolio name for symbol "${symbol}".`,
        rawFields: raw.rawFields,
      });
      continue;
    }

    const inferred = inferInstrumentMetadata({
      symbol,
      name: raw.name,
      exchangeCode: raw.exchange,
      currency: raw.currency,
    });

    const upperCurrency = inferred.currency.toUpperCase();
    if (upperCurrency !== "USD" && upperCurrency !== "SGD") {
      rejectedRows.push({
        lineNumber: raw.lineNumber,
        sourceRowId: raw.sourceRowId,
        portfolio,
        symbol,
        type: rawType,
        reason: `Unsupported currency "${raw.currency}". Only USD and SGD are supported.`,
        rawFields: raw.rawFields,
      });
      continue;
    }
    const currency: "USD" | "SGD" = upperCurrency;

    const priorCurrency = symbolCurrencyMap.get(symbol);
    if (priorCurrency && priorCurrency !== currency) {
      rejectedRows.push({
        lineNumber: raw.lineNumber,
        sourceRowId: raw.sourceRowId,
        portfolio,
        symbol,
        type: rawType,
        reason: `Currency mismatch for "${symbol}": previously seen as ${priorCurrency}, but this row specifies ${currency}.`,
        rawFields: raw.rawFields,
      });
      continue;
    }
    symbolCurrencyMap.set(symbol, currency);

    // Placeholder row check (Section 7.2A)
    if (rawType === "") {
      const hasStrayValues =
        raw.sharesOwned.trim() !== "" ||
        raw.costPerShare.trim() !== "" ||
        raw.transactionDate.trim() !== "";

      if (hasStrayValues) {
        rejectedRows.push({
          lineNumber: raw.lineNumber,
          sourceRowId: raw.sourceRowId,
          portfolio,
          symbol,
          type: "",
          reason:
            "Transaction Type is empty, expected Buy, Sell, Sell All, or Dividend when shares/price/date are present.",
          rawFields: raw.rawFields,
        });
        continue;
      }

      candidateRows.push({
        kind: "placeholder",
        lineNumber: raw.lineNumber,
        sourceRowId: raw.sourceRowId,
        portfolio,
        symbol,
        rawName: raw.name,
        rawDisplaySymbol: raw.displaySymbol,
        rawExchange: raw.exchange.trim(),
        currency,
        assetType: inferred.assetType,
      });
      continue;
    }

    if (!VALID_TYPES.has(rawType as ValidTransactionType)) {
      rejectedRows.push({
        lineNumber: raw.lineNumber,
        sourceRowId: raw.sourceRowId,
        portfolio,
        symbol,
        type: rawType,
        reason: `Unknown transaction Type "${rawType}". Expected Buy, Sell, Sell All, or Dividend.`,
        rawFields: raw.rawFields,
      });
      continue;
    }
    const txType = rawType as ValidTransactionType;

    // Validate Shares Owned
    const rawQty = raw.sharesOwned.trim();
    if (!isValidDecimalText(rawQty)) {
      rejectedRows.push({
        lineNumber: raw.lineNumber,
        sourceRowId: raw.sourceRowId,
        portfolio,
        symbol,
        type: txType,
        reason: `Non-numeric Shares Owned "${raw.sharesOwned}".`,
        rawFields: raw.rawFields,
      });
      continue;
    }
    const qtyDecimal = txType === "Sell All" ? toDecimal(0) : toDecimal(rawQty);
    if (txType !== "Sell All" && !isStrictlyPositive(qtyDecimal)) {
      rejectedRows.push({
        lineNumber: raw.lineNumber,
        sourceRowId: raw.sourceRowId,
        portfolio,
        symbol,
        type: txType,
        reason: `${txType} Shares Owned must be greater than zero (got "${raw.sharesOwned}").`,
        rawFields: raw.rawFields,
      });
      continue;
    }

    // Validate Cost Per Share (price)
    const rawPrice = raw.costPerShare.trim();
    if (!isValidDecimalText(rawPrice)) {
      rejectedRows.push({
        lineNumber: raw.lineNumber,
        sourceRowId: raw.sourceRowId,
        portfolio,
        symbol,
        type: txType,
        reason: `Non-numeric Cost Per Share "${raw.costPerShare}".`,
        rawFields: raw.rawFields,
      });
      continue;
    }
    const priceDecimal = toDecimal(rawPrice);
    if (priceDecimal.isNegative()) {
      rejectedRows.push({
        lineNumber: raw.lineNumber,
        sourceRowId: raw.sourceRowId,
        portfolio,
        symbol,
        type: txType,
        reason: `Cost Per Share cannot be negative (got "${raw.costPerShare}").`,
        rawFields: raw.rawFields,
      });
      continue;
    }

    // Validate Commission
    let parsedCommission;
    try {
      parsedCommission = parseCommissionInput(
        raw.commission.trim() === "" ? "0" : raw.commission,
      );
    } catch (error) {
      rejectedRows.push({
        lineNumber: raw.lineNumber,
        sourceRowId: raw.sourceRowId,
        portfolio,
        symbol,
        type: txType,
        reason:
          error instanceof Error
            ? error.message
            : `Invalid Commission "${raw.commission}".`,
        rawFields: raw.rawFields,
      });
      continue;
    }

    // Validate Date & Time
    let parsedTimestamp;
    try {
      parsedTimestamp = parseDateAndTimeWithOffset(
        raw.transactionDate,
        raw.transactionTime,
        "+0800",
      );
    } catch (error) {
      rejectedRows.push({
        lineNumber: raw.lineNumber,
        sourceRowId: raw.sourceRowId,
        portfolio,
        symbol,
        type: txType,
        reason:
          error instanceof Error
            ? error.message
            : `Invalid Transaction Date/Time "${raw.transactionDate} ${raw.transactionTime}".`,
        rawFields: raw.rawFields,
      });
      continue;
    }

    // Validate optional Purchase Exchange Rate
    let purchaseFxRate: string | null = null;
    if (raw.purchaseExchangeRate.trim() !== "") {
      if (!isValidDecimalText(raw.purchaseExchangeRate)) {
        rejectedRows.push({
          lineNumber: raw.lineNumber,
          sourceRowId: raw.sourceRowId,
          portfolio,
          symbol,
          type: txType,
          reason: `Non-numeric Purchase Exchange Rate "${raw.purchaseExchangeRate}".`,
          rawFields: raw.rawFields,
        });
        continue;
      }
      const fxDec = toDecimal(raw.purchaseExchangeRate);
      if (!isStrictlyPositive(fxDec)) {
        rejectedRows.push({
          lineNumber: raw.lineNumber,
          sourceRowId: raw.sourceRowId,
          portfolio,
          symbol,
          type: txType,
          reason: `Purchase Exchange Rate must be greater than zero.`,
          rawFields: raw.rawFields,
        });
        continue;
      }
      purchaseFxRate = toDecimalString(fxDec, 12);
    }

    const dedupeHash = computeTransactionDedupeHash({
      portfolioName: portfolio,
      symbol,
      type: txType,
      quantity: qtyDecimal,
      price: priceDecimal,
      executedAt: parsedTimestamp.executedAt,
    });

    // Preserve exact accounting string from MSP CSV (`""` -> `null`, `"FIFO"` -> `"FIFO"`).
    // On plain template imports where accounting was omitted, default non-Buys to `"FIFO"`.
    const accounting =
      raw.format === "msp"
        ? raw.accounting === ""
          ? null
          : raw.accounting
        : txType === "Buy"
          ? null
          : "FIFO";

    candidateRows.push({
      kind: "transaction",
      validationKey: `line-${raw.lineNumber}`,
      lineNumber: raw.lineNumber,
      sourceRowId: raw.sourceRowId,
      portfolio,
      symbol,
      rawName: raw.name,
      rawDisplaySymbol: raw.displaySymbol,
      rawExchange: raw.exchange.trim(),
      currency,
      assetType: inferred.assetType,
      type: txType,
      quantity: toDecimalString(qtyDecimal, 12),
      price: toDecimalString(priceDecimal, 12),
      commissionRaw: parsedCommission.raw ?? "0",
      commissionValue: toDecimalString(parsedCommission.value, 12),
      commissionIsPercent: parsedCommission.isPercent,
      executedAt: parsedTimestamp.executedAt,
      originalOffset: parsedTimestamp.originalOffset,
      localDate: parsedTimestamp.localDate,
      localTime: parsedTimestamp.localTime,
      purchaseFxRate,
      purchaseFxCurrencies:
        raw.purchaseExchangeCurrencies === ""
          ? null
          : raw.purchaseExchangeCurrencies,
      accounting,
      accountingExecutionIds:
        raw.accountingExecutionIds === "" ? null : raw.accountingExecutionIds,
      notes: raw.notes === "" ? null : raw.notes,
      outgoingCashLink:
        raw.outgoingCashLink === "" ? null : raw.outgoingCashLink,
      dedupeHash,
      rawRow: raw,
    });
  }

  // Chronological FIFO validation per symbol across portfolios: isolate any
  // Sell / Sell All row that oversells holdings so remaining valid rows can
  // still import, while honouring symbol-wide `Sell All`.
  const txGroupsBySymbol = new Map<string, ValidatedTransactionRow[]>();
  for (const row of candidateRows) {
    if (row.kind === "transaction") {
      const list = txGroupsBySymbol.get(row.symbol) ?? [];
      list.push(row);
      txGroupsBySymbol.set(row.symbol, list);
    }
  }

  const oversoldKeys = new Set<string>();
  for (const [symbol, symbolRows] of txGroupsBySymbol.entries()) {
    let activeSymbolRows = [...symbolRows];

    while (activeSymbolRows.length > 0) {
      const byPortfolio = new Map<string, ValidatedTransactionRow[]>();
      for (const tx of activeSymbolRows) {
        const list = byPortfolio.get(tx.portfolio) ?? [];
        list.push(tx);
        byPortfolio.set(tx.portfolio, list);
      }

      const expanded = applySymbolWideSellAll(
        [...byPortfolio.entries()].map(([portfolioId, rows]) => ({
          portfolioId,
          transactions: rows.map(
            (tx): LedgerTransactionInput => ({
              id: tx.validationKey,
              type: tx.type,
              quantity: tx.quantity,
              price: tx.price,
              commissionRaw: tx.commissionRaw,
              commissionValue: tx.commissionValue,
              commissionIsPercent: tx.commissionIsPercent,
              executedAt: tx.executedAt,
              originalOffset: tx.originalOffset,
              currency: tx.currency,
              purchaseFxRate: tx.purchaseFxRate,
              purchaseFxCurrencies: tx.purchaseFxCurrencies,
              sourceRowId: tx.sourceRowId,
            }),
          ),
        })),
        { symbol, dividendMode },
      );

      let failed = false;
      for (const ledger of expanded) {
        try {
          evaluateFifoLedger(ledger.transactions, {
            symbol,
            dividendMode,
            onValidationError: "throw",
          });
        } catch (error) {
          if (error instanceof FifoValidationError) {
            const sourceKey = resolveSellAllSourceId(
              error.issue.transactionId,
            );
            const offending = activeSymbolRows.find(
              (tx) => tx.validationKey === sourceKey,
            );
            if (offending) {
              oversoldKeys.add(offending.validationKey);
              rejectedRows.push({
                lineNumber: offending.lineNumber,
                sourceRowId: offending.sourceRowId,
                portfolio: offending.portfolio,
                symbol: offending.symbol,
                type: offending.type,
                reason: error.message,
                rawFields: offending.rawRow.rawFields,
              });
              activeSymbolRows = activeSymbolRows.filter(
                (tx) => tx.validationKey !== offending.validationKey,
              );
              failed = true;
              break;
            }
          }
          break;
        }
      }

      if (!failed) {
        break;
      }
    }
  }

  rejectedRows.sort((a, b) => a.lineNumber - b.lineNumber);

  const validRows = candidateRows.filter(
    (row) => row.kind === "placeholder" || !oversoldKeys.has(row.validationKey),
  );

  // Build portfolio summaries, type counts, detected symbols, and warnings
  const portfolioStats = new Map<
    string,
    {
      symbols: Set<string>;
      currencies: Set<"USD" | "SGD">;
      placeholderCount: number;
      transactionCount: number;
    }
  >();

  const typeCounts: Record<ValidTransactionType, number> = {
    Buy: 0,
    Sell: 0,
    "Sell All": 0,
    Dividend: 0,
  };

  const detectedSymbolMap = new Map<
    string,
    {
      symbol: string;
      name: string;
      exchange: string;
      currency: "USD" | "SGD";
      assetType: AssetClass;
    }
  >();

  const warnings: CsvWarningItem[] = [];
  const warnedCryptoSymbols = new Set<string>();
  const warnedMissingMetaSymbols = new Set<string>();

  let placeholderCount = 0;
  let transactionCount = 0;

  for (const row of validRows) {
    const pStat = portfolioStats.get(row.portfolio) ?? {
      symbols: new Set<string>(),
      currencies: new Set<"USD" | "SGD">(),
      placeholderCount: 0,
      transactionCount: 0,
    };
    pStat.symbols.add(row.symbol);
    pStat.currencies.add(row.currency);

    if (row.kind === "placeholder") {
      placeholderCount += 1;
      pStat.placeholderCount += 1;
    } else {
      transactionCount += 1;
      pStat.transactionCount += 1;
      typeCounts[row.type] += 1;

      if (row.type === "Buy" && toDecimal(row.price).isZero()) {
        warnings.push({
          kind: "zero_cost_buy",
          message: `Zero-cost Buy on ${row.localDate}: ${row.quantity} shares of ${row.symbol} in "${row.portfolio}" at price 0.`,
        });
      }
    }
    portfolioStats.set(row.portfolio, pStat);

    const existingSym = detectedSymbolMap.get(row.symbol);
    if (!existingSym) {
      detectedSymbolMap.set(row.symbol, {
        symbol: row.symbol,
        name: row.rawName.trim(),
        exchange: row.rawExchange,
        currency: row.currency,
        assetType: row.assetType,
      });
    } else {
      if (!existingSym.name && row.rawName.trim()) {
        existingSym.name = row.rawName.trim();
      }
      if (!existingSym.exchange && row.rawExchange) {
        existingSym.exchange = row.rawExchange;
      }
    }

    if (row.assetType === "crypto" && !warnedCryptoSymbols.has(row.symbol)) {
      warnedCryptoSymbols.add(row.symbol);
      warnings.push({
        kind: "crypto_unpriced",
        message: `${row.symbol} (${row.portfolio}) is a crypto symbol. Live crypto pricing is disabled — it will import losslessly and display as "price unavailable" unless you set a manual price or mark it worthless.`,
      });
    } else if (
      row.assetType !== "crypto" &&
      row.rawName.trim() === "" &&
      row.rawExchange === "" &&
      !warnedMissingMetaSymbols.has(row.symbol)
    ) {
      warnedMissingMetaSymbols.add(row.symbol);
      warnings.push({
        kind: "missing_metadata",
        message: `${row.symbol} (${row.portfolio}) has an empty Name and Exchange in the CSV (possibly delisted/acquired). Imported as-is for lossless export.`,
      });
    }
  }

  const portfolios: PortfolioPreviewSummary[] = [];
  for (const [name, stat] of portfolioStats.entries()) {
    const defaultCurrency: "USD" | "SGD" =
      stat.currencies.size === 1 && stat.currencies.has("SGD") ? "SGD" : "USD";
    portfolios.push({
      name,
      inferredType: stat.transactionCount === 0 ? "watchlist" : "holdings",
      defaultCurrency,
      symbolCount: stat.symbols.size,
      placeholderCount: stat.placeholderCount,
      transactionCount: stat.transactionCount,
    });
  }

  const sampleRows: CsvSamplePreviewRow[] = validRows
    .slice(0, 12)
    .map((row) => {
      if (row.kind === "placeholder") {
        return {
          lineNumber: row.lineNumber,
          id: row.sourceRowId,
          portfolio: row.portfolio,
          symbol: row.symbol,
          name: row.rawName.trim(),
          kind: "Placeholder",
          quantity: "—",
          price: "—",
          currency: row.currency,
          date: "—",
        };
      }
      return {
        lineNumber: row.lineNumber,
        id: row.sourceRowId,
        portfolio: row.portfolio,
        symbol: row.symbol,
        name: row.rawName.trim(),
        kind: row.type,
        quantity: row.quantity,
        price: row.price,
        currency: row.currency,
        date: `${row.localDate} ${row.localTime}`,
      };
    });

  return {
    format: doc.format,
    headers: doc.headers,
    totalDataRows: doc.rows.length,
    placeholderCount,
    transactionCount,
    validRows,
    rejectedRows,
    portfolios,
    typeCounts,
    detectedSymbols: [...detectedSymbolMap.values()],
    warnings,
    sampleRows,
  };
}
