/**
 * Human-friendly number, currency, and signed-gain formatters.
 *
 * Uses `Intl.NumberFormat` while respecting high-precision trade prices and
 * fractional share counts (e.g. `0.919` SGD on SGX ETFs or fractional shares).
 */

/** Formats a monetary value such as `S$1,234.56` or `US$50.58`. */
export function formatMoney(
  value: string | number | null | undefined,
  currency: string = "USD",
  options: {
    locale?: string;
    signed?: boolean;
    maximumFractionDigits?: number;
  } = {},
): string {
  if (value === null || value === undefined || value === "") {
    return "—";
  }

  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return "—";
  }

  const locale = options.locale ?? "en-SG";
  const absValue = Math.abs(numeric);
  const maxFraction =
    options.maximumFractionDigits ??
    (absValue > 0 && absValue < 1 ? 4 : 2);

  const formatted = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.max(2, maxFraction),
  }).format(absValue);

  if (options.signed) {
    if (numeric > 0) {
      return `+${formatted}`;
    }
    if (numeric < 0) {
      return `−${formatted}`;
    }
    return formatted;
  }

  if (numeric < 0) {
    return `−${formatted}`;
  }
  return formatted;
}

/** Formats a share or unit quantity without unnecessary trailing zeros. */
export function formatQuantity(
  value: string | number | null | undefined,
  locale: string = "en-SG",
): string {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return "—";
  }
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  }).format(numeric);
}

/** Formats a percentage with an explicit `+` or `−` sign when `signed` is true. */
export function formatPercent(
  value: string | number | null | undefined,
  options: { signed?: boolean; fractionDigits?: number } = {},
): string {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return "—";
  }
  const digits = options.fractionDigits ?? 2;
  const absFormatted = `${Math.abs(numeric).toFixed(digits)}%`;

  if (options.signed) {
    if (numeric > 0) {
      return `+${absFormatted}`;
    }
    if (numeric < 0) {
      return `−${absFormatted}`;
    }
  } else if (numeric < 0) {
    return `−${absFormatted}`;
  }
  return absFormatted;
}

/**
 * Formats large counts such as trading volume (`45.20M`, `812.4K`) cleanly.
 */
export function formatCompactNumber(
  value: string | number | null | undefined,
  locale: string = "en-SG",
): string {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return "—";
  }
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(numeric);
}

/**
 * Formats large monetary figures such as market capitalization (`US$3.42T`, `S$94.1B`).
 */
export function formatCompactMoney(
  value: string | number | null | undefined,
  currency: string = "USD",
  locale: string = "en-SG",
): string {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return "—";
  }
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.toUpperCase(),
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(numeric);
}


