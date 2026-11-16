/**
 * Human-friendly number, currency, and signed-gain formatters.
 *
 * Uses `Intl.NumberFormat` while capping displayed price and monetary values
 * at a maximum of 2 decimal places (`formatQuantity` retains up to 6 decimals
 * for fractional shares).
 */

/** Formats a monetary value such as `S$1,234.56` or `US$50.58` (max 2 d.p.). */
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
  const maxFraction = Math.min(
    2,
    Math.max(0, options.maximumFractionDigits ?? 2),
  );
  const minFraction = Math.min(2, maxFraction);

  const formatted = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: minFraction,
    maximumFractionDigits: maxFraction,
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

/**
 * Compacts verbose quote freshness labels for dense table cells
 * (e.g. `"Last close, 13 Nov"` -> `"13 Nov"`, `"Manual price"` -> `"Manual"`).
 */
export function formatCompactFreshness(
  label: string | null | undefined,
): string {
  if (!label) {
    return "—";
  }
  const trimmed = label.trim();
  if (!trimmed) {
    return "—";
  }
  if (/^(Last close|Cached close),\s*/i.test(trimmed)) {
    return trimmed.replace(/^(Last close|Cached close),\s*/i, "");
  }
  if (/^Close on\s+/i.test(trimmed)) {
    return trimmed.replace(/^Close on\s+/i, "");
  }
  if (/^Delayed\b/i.test(trimmed)) {
    return "Delayed";
  }
  if (/^Manual price$/i.test(trimmed)) {
    return "Manual";
  }
  if (/^Delisted\s*\/\s*Worthless$/i.test(trimmed)) {
    return "Delisted";
  }
  if (/^Price unavailable$/i.test(trimmed)) {
    return "Unavailable";
  }
  if (/^Price not found$/i.test(trimmed)) {
    return "Not found";
  }
  return trimmed;
}


