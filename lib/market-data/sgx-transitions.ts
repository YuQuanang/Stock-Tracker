/**
 * Verified Singapore Exchange (SGX) ticker renames and corporate consolidations.
 *
 * When SGX retires a counter code following a reverse split / consolidation
 * (e.g. ESR-REIT moving from `J91U.SI` to `9A4U.SI` after its 10-for-1 unit
 * consolidation on 30 Apr 2025), quoting the retired symbol returns HTTP 404
 * across Yahoo Finance, TradingView, and Stooq. This registry surfaces the
 * exact replacement ticker and consolidation ratio so users can safely migrate
 * their instrument without silent share-count distortion.
 */

export interface SgxTickerTransition {
  oldSymbol: string;
  newSymbol: string;
  companyName: string;
  /** Ex-date / effective corporate action date (`YYYY-MM-DD`). */
  effectiveDate: string;
  /** Post-consolidation split numerator (1 for a 10-for-1 consolidation). */
  ratioNumerator: number;
  /** Post-consolidation split denominator (10 for a 10-for-1 consolidation). */
  ratioDenominator: number;
  reason: string;
}

const SGX_TICKER_TRANSITIONS: Record<string, SgxTickerTransition> = {
  "J91U.SI": {
    oldSymbol: "J91U.SI",
    newSymbol: "9A4U.SI",
    companyName: "ESR-REIT",
    effectiveDate: "2025-04-30",
    ratioNumerator: 1,
    ratioDenominator: 10,
    reason:
      "ESR-REIT completed a 10-for-1 unit consolidation on 30 Apr 2025 and moved from J91U.SI to 9A4U.SI.",
  },
};

/**
 * Looks up a verified SGX corporate ticker transition by Yahoo-style `.SI`
 * symbol or bare SGX counter code (e.g. `"J91U.SI"` or `"J91U"`).
 */
export function getSgxTickerTransition(
  rawSymbol: string,
): SgxTickerTransition | null {
  const clean = rawSymbol.trim().toUpperCase();
  if (!clean) {
    return null;
  }
  const normalized = clean.endsWith(".SI") || clean.startsWith("^")
    ? clean
    : `${clean}.SI`;
  return SGX_TICKER_TRANSITIONS[clean] ?? SGX_TICKER_TRANSITIONS[normalized] ?? null;
}

export function formatTransitionReason(transition: SgxTickerTransition): string {
  return `${transition.reason} Update ticker to ${transition.newSymbol} (with ${transition.ratioNumerator}:${transition.ratioDenominator} consolidation if units are pre-split) to fetch live quotes.`;
}

