/**
 * CSV writers for:
 *  1. Lossless original Microsoft Start / MSN Money format (`MSP-Portfolios-YYYY-MM-DD.csv`)
 *  2. Clean modern CSV with ISO-8601 UTC timestamps, SGD snapshots, and
 *     spreadsheet formula-injection protection (`=`, `+`, `-`, `@`)
 *  3. Rejected-rows CSV so users can inspect, fix, and re-upload invalid rows
 */
import { formatInstantInOffset, toDecimal, toDecimalString } from "@/lib/finance";
import type { RejectedCsvRow } from "@/lib/csv/validate";

/**
 * Exact 19-column header from `MSP-Portfolios-2026-11-07.csv`, including the
 * 8 trailing spaces on `OutgoingCashLink        `.
 */
export const MSP_CSV_HEADER =
  "Id,Symbol,Name,Display Symbol,Exchange,Portfolio,Currency,Shares Owned,Cost Per Share,Commission,Transaction Date,Transaction Time,Purchase Exchange Rate,Purchase Exchange Currencies,Type,Accounting,Accounting Execution Ids,Notes,OutgoingCashLink        ";

export const MSP_GROUP_SEPARATOR_LINE = "        ";

export interface MspExportTransactionItem {
  type: "Buy" | "Sell" | "Sell All" | "Dividend";
  currency: string;
  quantity: string;
  price: string;
  commissionRaw: string | null;
  executedAt: Date;
  originalOffset: string;
  purchaseFxRate: string | null;
  purchaseFxCurrencies: string | null;
  accountingMethod: string | null;
  accountingExecutionIds: string | null;
  notes: string | null;
  outgoingCashLink: string | null;
}

export interface MspExportSymbolGroup {
  portfolioName: string;
  symbol: string;
  /** Exact imported Name (`""` when empty in CSV) or current display name. */
  name: string;
  displaySymbol: string;
  exchange: string;
  currency: string;
  transactions: MspExportTransactionItem[];
}

/**
 * Quotes non-empty values in double quotes (escaping `"` as `""`) and leaves
 * empty values completely unquoted (`""`), matching Microsoft Start exports.
 */
export function formatMspField(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  const escaped = value.replaceAll('"', '""');
  return `"${escaped}"`;
}

function formatMspRow(fields: (string | null | undefined)[]): string {
  return fields.map(formatMspField).join(",");
}

/**
 * Serialises symbol groups into the exact Microsoft Start / MSN Money CSV
 * layout:
 *  - Original 19-column header (with trailing spaces)
 *  - Blank line after header
 *  - Placeholder row at the start of every `(portfolio, symbol)` group
 *  - Chronological transaction rows with consecutive 1-based `Id`s
 *  - 8-space separator line after each group
 */
export function writeMspCsv(groups: MspExportSymbolGroup[]): string {
  const lines: string[] = [MSP_CSV_HEADER, ""];
  let nextId = 1;

  for (const group of groups) {
    // 1. Placeholder row for this (portfolio, symbol)
    const placeholderId = String(nextId);
    nextId += 1;

    lines.push(
      formatMspRow([
        placeholderId,
        group.symbol,
        group.name,
        group.displaySymbol,
        group.exchange,
        group.portfolioName,
        group.currency,
        "", // Shares Owned
        "", // Cost Per Share
        "", // Commission
        "", // Transaction Date
        "", // Transaction Time
        "", // Purchase Exchange Rate
        "", // Purchase Exchange Currencies
        "", // Type
        "", // Accounting
        "", // Accounting Execution Ids
        "", // Notes
        "", // OutgoingCashLink
      ]),
    );

    // 2. Transaction rows in chronological + sourceRowId order
    for (const tx of group.transactions) {
      const txId = String(nextId);
      nextId += 1;

      const formattedTime = formatInstantInOffset(
        tx.executedAt,
        tx.originalOffset,
      );
      const quantityText =
        tx.type === "Sell All"
          ? "0"
          : toDecimalString(toDecimal(tx.quantity), 12);
      const priceText = toDecimalString(toDecimal(tx.price), 12);
      const commissionText = tx.commissionRaw ?? "0";
      const fxText = tx.purchaseFxRate
        ? toDecimalString(toDecimal(tx.purchaseFxRate), 12)
        : "";

      lines.push(
        formatMspRow([
          txId,
          group.symbol,
          group.name,
          group.displaySymbol,
          group.exchange,
          group.portfolioName,
          tx.currency,
          quantityText,
          priceText,
          commissionText,
          formattedTime.csvDate,
          formattedTime.localTime,
          fxText,
          tx.purchaseFxCurrencies ?? "",
          tx.type,
          tx.accountingMethod ?? "",
          tx.accountingExecutionIds ?? "",
          tx.notes ?? "",
          tx.outgoingCashLink ?? "",
        ]),
      );
    }

    lines.push(MSP_GROUP_SEPARATOR_LINE);
  }

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Clean Modern CSV Export (with Spreadsheet Formula-Injection Guard)
// ---------------------------------------------------------------------------

const FORMULA_TRIGGER_PREFIX = /^[=+\-@\t\r]/;

/**
 * Prefixes text cells starting with `=`, `+`, `-`, `@`, `\t`, or `\r` with a
 * leading apostrophe (`'`) so Excel / Google Sheets / Numbers never execute
 * untrusted formulas.
 *
 * Applied ONLY to the clean modern CSV export — NEVER to the original MSP CSV.
 */
export function sanitizeSpreadsheetFormulaCell(value: string): string {
  if (value === "") {
    return "";
  }
  if (FORMULA_TRIGGER_PREFIX.test(value)) {
    return `'${value}`;
  }
  return value;
}

function quoteStandardCsvCell(value: string): string {
  if (
    value.includes(",") ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

export interface CleanCsvRowInput {
  id: string;
  portfolioName: string;
  symbol: string;
  instrumentName: string | null;
  exchangeCode: string | null;
  type: string;
  currency: string;
  quantity: string;
  price: string;
  commissionRaw: string | null;
  executedAtIso: string;
  localDate: string;
  localTime: string;
  fxRateToSgd: string | null;
  fxSource: string | null;
  totalCostSgd: string | null;
  isManualPrice: boolean;
  isManualFxRate: boolean;
  notes: string | null;
}

const CLEAN_CSV_HEADERS = [
  "TransactionId",
  "Portfolio",
  "Symbol",
  "CompanyName",
  "Exchange",
  "Type",
  "Currency",
  "Quantity",
  "PricePerShare",
  "Commission",
  "ExecutedAtUTC",
  "LocalDateSGT",
  "LocalTimeSGT",
  "FxRateToSGD",
  "FxSource",
  "TotalCostSGD",
  "ManualPrice",
  "ManualFxRate",
  "Notes",
] as const;

export function writeCleanCsv(rows: CleanCsvRowInput[]): string {
  const lines: string[] = [CLEAN_CSV_HEADERS.join(",")];

  for (const row of rows) {
    const cells = [
      row.id,
      sanitizeSpreadsheetFormulaCell(row.portfolioName),
      sanitizeSpreadsheetFormulaCell(row.symbol),
      sanitizeSpreadsheetFormulaCell(row.instrumentName ?? ""),
      sanitizeSpreadsheetFormulaCell(row.exchangeCode ?? ""),
      row.type,
      row.currency,
      row.quantity,
      row.price,
      sanitizeSpreadsheetFormulaCell(row.commissionRaw ?? "0"),
      row.executedAtIso,
      row.localDate,
      row.localTime,
      row.fxRateToSgd ?? "",
      sanitizeSpreadsheetFormulaCell(row.fxSource ?? ""),
      row.totalCostSgd ?? "",
      row.isManualPrice ? "true" : "false",
      row.isManualFxRate ? "true" : "false",
      sanitizeSpreadsheetFormulaCell(row.notes ?? ""),
    ];

    lines.push(cells.map(quoteStandardCsvCell).join(","));
  }

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Rejected Rows CSV Writer
// ---------------------------------------------------------------------------

export function writeRejectedRowsCsv(
  originalHeaders: string[],
  rejectedRows: RejectedCsvRow[],
): string {
  const headers = ["LineNumber", "ErrorReason", ...originalHeaders];
  const lines: string[] = [headers.map(quoteStandardCsvCell).join(",")];

  for (const rejected of rejectedRows) {
    const paddedRaw = originalHeaders.map(
      (_, idx) => rejected.rawFields[idx] ?? "",
    );
    const rowCells = [
      String(rejected.lineNumber),
      sanitizeSpreadsheetFormulaCell(rejected.reason),
      ...paddedRaw,
    ];
    lines.push(rowCells.map(quoteStandardCsvCell).join(","));
  }

  return `${lines.join("\n")}\n`;
}

