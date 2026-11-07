import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { formatMoney, formatPercent } from "@/lib/format";

interface GainBadgeProps {
  /** Signed monetary amount, e.g. `"142.50"` or `"-35.20"`. */
  amount?: string | number | null;
  currency?: string;
  /** Signed percentage, e.g. `"12.4"` or `"-3.15"`. */
  percent?: string | number | null;
  size?: "sm" | "md";
  pill?: boolean;
}

/**
 * Accessible gain/loss indicator.
 *
 * Follows WCAG AA + Folio's design rule: never rely on colour alone — always
 * pair `--gain` / `--loss` with explicit `+` / `−` signs and directional arrows.
 */
export function GainBadge({
  amount,
  currency = "USD",
  percent,
  size = "md",
  pill = false,
}: GainBadgeProps) {
  const numericBasis =
    amount !== null && amount !== undefined && amount !== ""
      ? Number(amount)
      : percent !== null && percent !== undefined && percent !== ""
        ? Number(percent)
        : Number.NaN;

  if (!Number.isFinite(numericBasis)) {
    return <span className="num text-ink-3">—</span>;
  }

  const isPositive = numericBasis > 0;
  const isNegative = numericBasis < 0;

  const toneClasses = isPositive
    ? pill
      ? "bg-gain/12 text-gain"
      : "text-gain"
    : isNegative
      ? pill
        ? "bg-loss/12 text-loss"
        : "text-loss"
      : pill
        ? "bg-surface-2 text-ink-2"
        : "text-ink-2";

  const sizeClasses =
    size === "sm"
      ? pill
        ? "px-2 py-0.5 text-[12px]"
        : "text-[12.5px]"
      : pill
        ? "px-2.5 py-0.5 text-[13px]"
        : "text-[13.5px]";

  const iconSize = size === "sm" ? 13 : 14;

  const formattedAmount =
    amount !== null && amount !== undefined && amount !== ""
      ? formatMoney(amount, currency, { signed: true })
      : null;

  const formattedPercent =
    percent !== null && percent !== undefined && percent !== ""
      ? formatPercent(percent, { signed: true })
      : null;

  return (
    <span
      className={`num inline-flex items-center gap-0.5 rounded-full font-medium ${toneClasses} ${sizeClasses}`}
    >
      {isPositive ? (
        <ArrowUpRight size={iconSize} strokeWidth={2.1} aria-hidden="true" />
      ) : isNegative ? (
        <ArrowDownRight size={iconSize} strokeWidth={2.1} aria-hidden="true" />
      ) : (
        <Minus size={iconSize - 1} strokeWidth={2} aria-hidden="true" />
      )}
      {formattedAmount && <span>{formattedAmount}</span>}
      {formattedAmount && formattedPercent && (
        <span className="opacity-85">({formattedPercent})</span>
      )}
      {!formattedAmount && formattedPercent && <span>{formattedPercent}</span>}
    </span>
  );
}

