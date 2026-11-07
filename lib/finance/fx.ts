/**
 * Foreign-exchange lookup and conversion.
 *
 * Rules (section 5.2, 7.8, and Working Rule 5):
 *   1. Native currency == target currency -> rate is 1 (identity).
 *   2. If a transaction carries an explicit `purchaseFxRate`, prefer it. If
 *      `purchaseFxCurrencies` specifies the reverse direction (e.g. `"SGD/USD"`
 *      when converting `"USD"` -> `"SGD"`), invert `1 / purchaseFxRate`.
 *   3. Otherwise look up the historical rate on `date` (`YYYY-MM-DD`). If the
 *      trade fell on a weekend or ECB holiday, step back up to `maxLookbackDays`
 *      calendar days (default 10) to find the nearest prior business day.
 *   4. Support inverse rate rows (`to -> from` inverted as `1 / rate`) when a
 *      direct `from -> to` row is absent.
 *   5. Never fabricate an FX rate: if none is found, return `rate: null` with
 *      `source: "missing"` so callers can surface it in the Data Quality panel.
 */
import {
  type DecimalInput,
  type DecimalValue,
  ONE,
  safeDivide,
  toDecimal,
  ZERO,
} from "@/lib/finance/decimal";

export interface FxRateEntry {
  /** Calendar date in `YYYY-MM-DD` format. */
  date: string;
  fromCurrency: string;
  toCurrency: string;
  /** Units of `toCurrency` per 1 unit of `fromCurrency`. */
  rate: DecimalInput;
}

export type FxRateSource =
  | "identity"
  | "transaction"
  | "exact"
  | "prior-business-day"
  | "missing";

export interface FxLookupResult {
  /** Multiplier: `amountInTo = amountInFrom * rate`, or null if unavailable. */
  rate: DecimalValue | null;
  /** Date of the matched historical rate when sourced from the table. */
  effectiveDate: string | null;
  source: FxRateSource;
}

/** Pre-indexed FX lookup map for fast repeated historical lookups. */
export class FxRateBook {
  private readonly directMap = new Map<string, DecimalValue>();

  constructor(entries: readonly FxRateEntry[] = []) {
    for (const entry of entries) {
      const from = entry.fromCurrency.trim().toUpperCase();
      const to = entry.toCurrency.trim().toUpperCase();
      const rate = toDecimal(entry.rate);
      if (rate.gt(ZERO)) {
        this.directMap.set(`${entry.date}|${from}|${to}`, rate);
      }
    }
  }

  /** Looks up a direct or inverted rate on one exact calendar date. */
  getExact(
    date: string,
    fromCurrency: string,
    toCurrency: string,
  ): DecimalValue | null {
    const direct = this.directMap.get(`${date}|${fromCurrency}|${toCurrency}`);
    if (direct !== undefined) {
      return direct;
    }

    const inverse = this.directMap.get(`${date}|${toCurrency}|${fromCurrency}`);
    if (inverse !== undefined) {
      return safeDivide(ONE, inverse);
    }

    return null;
  }
}

/** Subtracts `days` calendar days from a `YYYY-MM-DD` date string. */
function stepBackCalendarDays(isoDate: string, days: number): string {
  const [yearStr, monthStr, dayStr] = isoDate.split("-");
  const utc = new Date(
    Date.UTC(Number(yearStr), Number(monthStr) - 1, Number(dayStr) - days),
  );
  const year = utc.getUTCFullYear();
  const month = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const day = String(utc.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Parses an optional `purchaseFxCurrencies` string such as `"USD/SGD"`,
 * `"USD->SGD"`, or `"USDSGD"` into `[from, to]`, or returns null if unrecognised.
 */
function parseFxPairLabel(
  rawPair: string | null | undefined,
): [string, string] | null {
  if (!rawPair) {
    return null;
  }
  const cleaned = rawPair.trim().toUpperCase();
  const delimited = cleaned.split(/[/\-:>_\s]+/).filter(Boolean);
  if (delimited.length === 2 && delimited[0].length === 3 && delimited[1].length === 3) {
    return [delimited[0], delimited[1]];
  }
  if (/^[A-Z]{6}$/.test(cleaned)) {
    return [cleaned.slice(0, 3), cleaned.slice(3, 6)];
  }
  return null;
}

export interface LookupFxRateParams {
  fromCurrency: string;
  toCurrency: string;
  /** Trade or valuation date in `YYYY-MM-DD`. */
  date: string;
  /** Optional per-transaction override rate. */
  explicitRate?: DecimalInput | null;
  /** Optional pair label accompanying `explicitRate`, e.g. `"USD/SGD"`. */
  explicitCurrencies?: string | null;
  /** Historical FX rate book. */
  rateBook: FxRateBook;
  /** Maximum days to walk back for weekends and holidays (default 10). */
  maxLookbackDays?: number;
}

/**
 * Resolves the conversion rate from `fromCurrency` to `toCurrency`.
 *
 * Formula in words:
 *   convertedAmount = nativeAmount * rate
 * where `rate` is units of `toCurrency` per 1 unit of `fromCurrency`.
 */
export function lookupFxRate(params: LookupFxRateParams): FxLookupResult {
  const from = params.fromCurrency.trim().toUpperCase();
  const to = params.toCurrency.trim().toUpperCase();

  if (from === to) {
    return {
      rate: ONE,
      effectiveDate: params.date,
      source: "identity",
    };
  }

  if (
    params.explicitRate !== null &&
    params.explicitRate !== undefined &&
    String(params.explicitRate).trim() !== ""
  ) {
    const rawRate = toDecimal(params.explicitRate);
    if (rawRate.gt(ZERO)) {
      const pair = parseFxPairLabel(params.explicitCurrencies);
      if (pair === null || (pair[0] === from && pair[1] === to)) {
        return {
          rate: rawRate,
          effectiveDate: params.date,
          source: "transaction",
        };
      }
      if (pair[0] === to && pair[1] === from) {
        const inverted = safeDivide(ONE, rawRate);
        if (inverted !== null) {
          return {
            rate: inverted,
            effectiveDate: params.date,
            source: "transaction",
          };
        }
      }
    }
  }

  const exact = params.rateBook.getExact(params.date, from, to);
  if (exact !== null) {
    return {
      rate: exact,
      effectiveDate: params.date,
      source: "exact",
    };
  }

  const maxLookback = params.maxLookbackDays ?? 10;
  for (let offset = 1; offset <= maxLookback; offset += 1) {
    const candidateDate = stepBackCalendarDays(params.date, offset);
    const candidateRate = params.rateBook.getExact(candidateDate, from, to);
    if (candidateRate !== null) {
      return {
        rate: candidateRate,
        effectiveDate: candidateDate,
        source: "prior-business-day",
      };
    }
  }

  return {
    rate: null,
    effectiveDate: null,
    source: "missing",
  };
}

/**
 * Converts a monetary amount using a resolved FX rate, returning `null` when
 * the rate is unavailable.
 *
 * Formula in words: convertedAmount = amount * rate.
 */
export function convertCurrencyAmount(
  amount: DecimalValue | null,
  rate: DecimalValue | null,
): DecimalValue | null {
  if (amount === null || rate === null) {
    return null;
  }
  return amount.mul(rate);
}
