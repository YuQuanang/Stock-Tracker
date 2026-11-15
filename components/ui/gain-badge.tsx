import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { formatMoney, formatPercent } from "@/lib/format";

interface GainBadgeProps {
  /** Signed monetary amount, e.g. `"142.50"` or `"-35.20"`. */
  amount?: string | number | null;
  currency?: string;
  /** Signed percentage, e.g. `"12.4"` or `"-3.15"`. */
  percent?: string | number | null;
  size?: "xs" | "sm" | "md" | "lg";
  pill?: boolean;
  /** `"stacked"` places the signed amount above the percentage to keep table rows narrow. */
  layout?: "inline" | "stacked";
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
  layout = "inline",
}: GainBadgeProps) {
  const numericBasis =
    amount !== null && amount !== undefined && amount !== ""
      ? Number(amount)
      : percent !== null && percent !== undefined && percent !== ""
        ? Number(percent)
        : Number.NaN;

  const nullSizeClass =
    size === "lg"
      ? "text-[16px] font-semibold"
      : size === "md"
        ? "text-[13.5px] font-medium"
        : size === "xs"
          ? "text-[11.5px] font-medium"
          : "text-[12.5px] font-medium";

  if (!Number.isFinite(numericBasis)) {
    return <span className={`num text-ink-2 ${nullSizeClass}`}>—</span>;
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
    size === "lg"
      ? pill
        ? "px-2.5 py-0.5 text-[14px] font-semibold"
        : "text-[16px] font-semibold tracking-[-0.015em]"
      : size === "xs"
        ? pill
          ? "px-1.5 py-0.5 text-[11.5px] font-medium"
          : "text-[11.5px] font-medium"
        : size === "sm"
          ? pill
            ? "px-2 py-0.5 text-[12px] font-medium"
            : "text-[12px] font-medium"
          : pill
            ? "px-2 py-0.5 text-[13px] font-medium"
            : "text-[13.5px] font-medium";

  const iconSize = size === "lg" ? 16 : size === "xs" ? 11 : 14;
  const gapClass = size === "xs" ? "gap-px" : "gap-0.5";

  const formattedAmount =
    amount !== null && amount !== undefined && amount !== ""
      ? formatMoney(amount, currency, { signed: true })
      : null;

  const formattedPercent =
    percent !== null && percent !== undefined && percent !== ""
      ? formatPercent(percent, { signed: true })
      : null;

  const arrowIcon = isPositive ? (
    <ArrowUpRight size={iconSize} strokeWidth={2.1} aria-hidden="true" />
  ) : isNegative ? (
    <ArrowDownRight size={iconSize} strokeWidth={2.1} aria-hidden="true" />
  ) : (
    <Minus size={iconSize - 1} strokeWidth={2} aria-hidden="true" />
  );

  if (layout === "stacked") {
    const percentClass =
      size === "lg"
        ? "text-[13px]"
        : size === "xs"
          ? "text-[10.5px]"
          : size === "sm"
            ? "text-[11px]"
            : "text-[11.5px]";

    return (
      <span
        className={`num inline-flex flex-col items-end rounded-[8px] leading-tight ${toneClasses} ${sizeClasses}`}
      >
        <span className={`inline-flex items-center ${gapClass}`}>
          {arrowIcon}
          <span>{formattedAmount ?? formattedPercent}</span>
        </span>
        {formattedAmount && formattedPercent && (
          <span className={`${percentClass} font-normal`}>
            {formattedPercent}
          </span>
        )}
      </span>
    );
  }

  return (
    <span
      className={`num inline-flex items-center ${gapClass} rounded-[8px] ${toneClasses} ${sizeClasses}`}
    >
      {arrowIcon}
      {formattedAmount && <span>{formattedAmount}</span>}
      {formattedAmount && formattedPercent && (
        <span className="opacity-85">({formattedPercent})</span>
      )}
      {!formattedAmount && formattedPercent && <span>{formattedPercent}</span>}
    </span>
  );
}

