/**
 * Lossless CSV parser for Microsoft Start / MSN Money portfolio exports
 * (`MSP-Portfolios-*.csv`) and Folio's plain CSV import template.
 *
 * Handles:
 *  - UTF-8 BOM (`\uFEFF`)
 *  - CRLF (`\r\n`), LF (`\n`), and CR (`\r`) line endings
 *  - Quoted values with RFC-4180 escaped quotes (`""`), embedded commas, and
 *    multi-line quoted notes
 *  - Unquoted empty fields (`,,`)
 *  - Blank and whitespace-only separator lines (silently skipped while keeping
 *    exact 1-based physical line numbers for validation errors)
 *  - Trailing spaces in header column names (e.g. `"OutgoingCashLink        "`)
 *    while preserving field value whitespace (e.g. `"JPMorgan Equity Premium Income "`)
 */

export type DetectedCsvFormat = "msp" | "plain";

export interface RawParsedCsvRow {
  /** 1-based physical line number in the uploaded file. */
  lineNumber: number;
  /** Which file layout produced this row. */
  format: DetectedCsvFormat;
  sourceRowId: number | null;
  symbol: string;
  name: string;
  displaySymbol: string;
  exchange: string;
  portfolio: string;
  currency: string;
  sharesOwned: string;
  costPerShare: string;
  commission: string;
  transactionDate: string;
  transactionTime: string;
  purchaseExchangeRate: string;
  purchaseExchangeCurrencies: string;
  type: string;
  accounting: string;
  accountingExecutionIds: string;
  notes: string;
  outgoingCashLink: string;
  /** Original raw field array for rejected-row CSV downloads. */
  rawFields: string[];
}

export interface ParsedCsvDocument {
  format: DetectedCsvFormat;
  rawHeaderLine: string;
  headers: string[];
  rows: RawParsedCsvRow[];
}

export class CsvFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvFormatError";
  }
}

export interface RawCsvPhysicalRecord {
  lineNumber: number;
  rawText: string;
  fields: string[];
}

/**
 * Splits a CSV string into physical records, respecting quoted multi-line
 * fields and skipping empty/whitespace-only separator lines after the header.
 */
export function parseCsvPhysicalRecords(input: string): RawCsvPhysicalRecord[] {
  const text = input.startsWith("\uFEFF") ? input.slice(1) : input;
  const records: RawCsvPhysicalRecord[] = [];

  let index = 0;
  let currentLine = 1;

  while (index < text.length) {
    const recordStartLine = currentLine;
    const recordStartOffset = index;
    const fields: string[] = [];
    let field = "";
    let inQuotes = false;
    let fieldStartedQuoted = false;
    let sawAnyCharacterOnLine = false;

    while (index < text.length) {
      const ch = text[index];

      if (inQuotes) {
        if (ch === '"') {
          if (text[index + 1] === '"') {
            field += '"';
            index += 2;
          } else {
            inQuotes = false;
            index += 1;
          }
        } else {
          if (ch === "\r") {
            currentLine += 1;
            field += ch;
            index += 1;
            if (text[index] === "\n") {
              field += "\n";
              index += 1;
            }
          } else {
            if (ch === "\n") {
              currentLine += 1;
            }
            field += ch;
            index += 1;
          }
        }
        continue;
      }

      if (ch === '"' && field === "" && !fieldStartedQuoted) {
        inQuotes = true;
        fieldStartedQuoted = true;
        sawAnyCharacterOnLine = true;
        index += 1;
        continue;
      }

      if (ch === ",") {
        fields.push(field);
        field = "";
        fieldStartedQuoted = false;
        sawAnyCharacterOnLine = true;
        index += 1;
        continue;
      }

      if (ch === "\r" || ch === "\n") {
        currentLine += 1;
        const recordEndOffset = index;
        if (ch === "\r" && text[index + 1] === "\n") {
          index += 2;
        } else {
          index += 1;
        }

        fields.push(field);
        const rawRecordText = text.slice(recordStartOffset, recordEndOffset);
        if (rawRecordText.trim() !== "") {
          records.push({
            lineNumber: recordStartLine,
            rawText: rawRecordText,
            fields,
          });
        }
        sawAnyCharacterOnLine = false;
        field = "";
        fieldStartedQuoted = false;
        break;
      }

      field += ch;
      sawAnyCharacterOnLine = true;
      index += 1;
    }

    if (inQuotes) {
      throw new CsvFormatError(
        `Unclosed double quote starting on line ${recordStartLine}.`,
      );
    }

    // Handle final line when file does not end with a trailing newline
    if (sawAnyCharacterOnLine || field !== "") {
      fields.push(field);
      const rawRecordText = text.slice(recordStartOffset, index);
      if (rawRecordText.trim() !== "") {
        records.push({
          lineNumber: recordStartLine,
          rawText: rawRecordText,
          fields,
        });
      }
    }
  }

  return records;
}

const MSP_REQUIRED_HEADERS = [
  "id",
  "symbol",
  "name",
  "display symbol",
  "exchange",
  "portfolio",
  "currency",
  "shares owned",
  "cost per share",
  "commission",
  "transaction date",
  "transaction time",
  "purchase exchange rate",
  "purchase exchange currencies",
  "type",
  "accounting",
  "accounting execution ids",
  "notes",
  "outgoingcashlink",
] as const;

const PLAIN_REQUIRED_HEADERS = [
  "symbol",
  "portfolio",
  "type",
  "shares",
  "price",
  "date",
] as const;

/**
 * Parses either a 19-column Microsoft Start (`MSP-Portfolios-*.csv`) export or
 * a plain Folio CSV template into normalized raw row objects.
 */
export function parsePortfolioCsv(csvContent: string): ParsedCsvDocument {
  const records = parseCsvPhysicalRecords(csvContent);
  if (records.length === 0) {
    throw new CsvFormatError("The uploaded CSV file is empty.");
  }

  const headerRecord = records[0];
  const normalizedHeaders = headerRecord.fields.map((col) =>
    col.trim().toLowerCase(),
  );

  const isMspFormat =
    normalizedHeaders.length === MSP_REQUIRED_HEADERS.length &&
    MSP_REQUIRED_HEADERS.every((expected, i) => normalizedHeaders[i] === expected);

  if (isMspFormat) {
    const rows: RawParsedCsvRow[] = [];
    for (let i = 1; i < records.length; i += 1) {
      const rec = records[i];
      const cols = rec.fields;
      const rawId = (cols[0] ?? "").trim();
      const parsedId =
        rawId !== "" && /^\d+$/.test(rawId) ? Number(rawId) : null;

      rows.push({
        lineNumber: rec.lineNumber,
        format: "msp",
        sourceRowId: parsedId,
        symbol: cols[1] ?? "",
        // Keep exact Name & Notes strings (including trailing spaces on Name!)
        name: cols[2] ?? "",
        displaySymbol: cols[3] ?? "",
        exchange: cols[4] ?? "",
        portfolio: cols[5] ?? "",
        currency: cols[6] ?? "",
        sharesOwned: cols[7] ?? "",
        costPerShare: cols[8] ?? "",
        commission: cols[9] ?? "",
        transactionDate: cols[10] ?? "",
        transactionTime: cols[11] ?? "",
        purchaseExchangeRate: cols[12] ?? "",
        purchaseExchangeCurrencies: cols[13] ?? "",
        type: cols[14] ?? "",
        accounting: cols[15] ?? "",
        accountingExecutionIds: cols[16] ?? "",
        notes: cols[17] ?? "",
        outgoingCashLink: cols[18] ?? "",
        rawFields: cols,
      });
    }

    return {
      format: "msp",
      rawHeaderLine: headerRecord.rawText,
      headers: headerRecord.fields.map((h) => h.trim()),
      rows,
    };
  }

  // Check plain template format (columns matched by header name in any order)
  const headerIndex = new Map<string, number>();
  normalizedHeaders.forEach((name, idx) => {
    if (name !== "" && !headerIndex.has(name)) {
      headerIndex.set(name, idx);
    }
  });

  const missingPlain = PLAIN_REQUIRED_HEADERS.filter(
    (col) => !headerIndex.has(col),
  );
  if (missingPlain.length > 0) {
    throw new CsvFormatError(
      `Unrecognised CSV header. Expected the 19-column Microsoft Start format or plain template columns (${PLAIN_REQUIRED_HEADERS.join(", ")}). Missing: ${missingPlain.join(", ")}.`,
    );
  }

  function readPlainCol(fields: string[], colName: string): string {
    const idx = headerIndex.get(colName);
    if (idx === undefined) {
      return "";
    }
    return fields[idx] ?? "";
  }

  const rows: RawParsedCsvRow[] = [];
  for (let i = 1; i < records.length; i += 1) {
    const rec = records[i];
    const cols = rec.fields;
    rows.push({
      lineNumber: rec.lineNumber,
      format: "plain",
      sourceRowId: i,
      symbol: readPlainCol(cols, "symbol"),
      name: readPlainCol(cols, "name"),
      displaySymbol: "",
      exchange: readPlainCol(cols, "exchange"),
      portfolio: readPlainCol(cols, "portfolio"),
      currency: readPlainCol(cols, "currency"),
      sharesOwned: readPlainCol(cols, "shares"),
      costPerShare: readPlainCol(cols, "price"),
      commission: readPlainCol(cols, "commission") || "0",
      transactionDate: readPlainCol(cols, "date"),
      transactionTime: readPlainCol(cols, "time") || "00:00:00",
      purchaseExchangeRate: readPlainCol(cols, "fx rate"),
      purchaseExchangeCurrencies: "",
      type: readPlainCol(cols, "type"),
      accounting: "",
      accountingExecutionIds: "",
      notes: readPlainCol(cols, "notes"),
      outgoingCashLink: "",
      rawFields: cols,
    });
  }

  return {
    format: "plain",
    rawHeaderLine: headerRecord.rawText,
    headers: headerRecord.fields.map((h) => h.trim()),
    rows,
  };
}

