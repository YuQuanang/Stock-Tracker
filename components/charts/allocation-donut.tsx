"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { SERIES_PALETTE } from "@/lib/charts/theme";
import { formatMoney, formatPercent } from "@/lib/format";
import { fadeQuick, springSmooth } from "@/lib/motion";
import type {
  AllocationDimension,
  AllocationSlice,
} from "@/lib/services/analytics";

interface AllocationDonutProps {
  allocations: Record<AllocationDimension, AllocationSlice[]>;
  currency: "SGD" | "USD";
  hasMissingSector?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

const DIMENSION_OPTIONS: readonly SegmentedOption<AllocationDimension>[] = [
  { value: "instrument", label: "Instrument" },
  { value: "assetClass", label: "Asset class" },
  { value: "sector", label: "Sector" },
  { value: "currency", label: "Currency" },
  { value: "region", label: "Region" },
];

/**
 * Interactive SVG Allocation Donut with keyboard/pointer hover focus, 5-dimension
 * segmented switcher, fixed-height center callout, and expandable breakdown list.
 */
export function AllocationDonut({
  allocations,
  currency,
  hasMissingSector = false,
  onExpandedChange,
}: AllocationDonutProps) {
  const [dimension, setDimension] = useState<AllocationDimension>("instrument");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  const slices = allocations[dimension] ?? [];
  const totalValue = slices.reduce((sum, s) => sum + Number(s.valueInBase), 0);
  const focusedSlice = slices.find((s) => s.key === activeKey) ?? null;

  // SVG stroke-dasharray geometry (radius 76 -> circumference ~ 477.52)
  const radius = 76;
  const circumference = 2 * Math.PI * radius;

  const segments = slices.reduce<{
    offsetAcc: number;
    items: (AllocationSlice & { color: string; arcLength: number; offset: number })[];
  }>(
    (acc, slice, index) => {
      const pct = Math.max(0, Number(slice.percent));
      const arcLength = (pct / 100) * circumference;
      const offset = -acc.offsetAcc;
      const color =
        slice.key === "__other__"
          ? SERIES_PALETTE[SERIES_PALETTE.length - 1]
          : SERIES_PALETTE[index % (SERIES_PALETTE.length - 1)];

      return {
        offsetAcc: acc.offsetAcc + arcLength,
        items: [
          ...acc.items,
          {
            ...slice,
            color,
            arcLength,
            offset,
          },
        ],
      };
    },
    { offsetAcc: 0, items: [] },
  ).items;

  return (
    <div className="@container flex flex-1 flex-col gap-4">
      <div className="no-scrollbar max-w-full overflow-x-auto">
        <SegmentedControl
          ariaLabel="Allocation breakdown dimension"
          options={DIMENSION_OPTIONS}
          value={dimension}
          size="sm"
          onChange={(next) => {
            setDimension(next);
            setActiveKey(null);
          }}
          layoutId="allocation-dimension-seg"
        />
      </div>

      {slices.length === 0 ? (
        <div className="my-auto flex h-48 items-center justify-center rounded-[12px] border border-dashed border-line bg-surface-2 px-4 text-center text-[13px] text-ink-2">
          No priced open holdings to allocate in this view.
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-4">
          {/* Interactive SVG Donut (top-anchored so expanding breakdown never shifts the chart) */}
          <div className="flex flex-col items-center gap-3.5 pt-3">
            <div className="relative flex h-[196px] w-[196px] items-center justify-center">
              <svg
                viewBox="0 0 200 200"
                className="h-full w-full -rotate-90"
                role="img"
                aria-label={`Portfolio allocation by ${dimension}`}
              >
                <circle
                  cx="100"
                  cy="100"
                  r={radius}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="22"
                  className="text-surface-2"
                />
                {segments.map((seg) => {
                  const isDimmed = activeKey !== null && activeKey !== seg.key;
                  const isHighlighted = activeKey === seg.key;
                  return (
                    <circle
                      key={seg.key}
                      cx="100"
                      cy="100"
                      r={radius}
                      fill="none"
                      stroke={seg.color}
                      strokeWidth={isHighlighted ? 26 : 22}
                      strokeDasharray={`${Math.max(0, seg.arcLength - 1.2)} ${circumference}`}
                      strokeDashoffset={seg.offset}
                      opacity={isDimmed ? 0.32 : 1}
                      className="cursor-pointer transition-all duration-150"
                      onMouseEnter={() => setActiveKey(seg.key)}
                      onMouseLeave={() => setActiveKey(null)}
                      onClick={() =>
                        setActiveKey((prev) => (prev === seg.key ? null : seg.key))
                      }
                    />
                  );
                })}
              </svg>

              {/* Center label inside donut ring */}
              <div className="pointer-events-none absolute inset-6 flex flex-col items-center justify-center text-center">
                {focusedSlice ? (
                  <>
                    <span className="max-w-[116px] truncate text-[12px] font-medium text-ink-2">
                      {focusedSlice.label}
                    </span>
                    <span className="num mt-0.5 text-[16px] font-semibold tracking-[-0.015em] text-ink">
                      {formatPercent(focusedSlice.percent)}
                    </span>
                    <span className="num text-[12px] text-ink-2">
                      {formatMoney(focusedSlice.valueInBase, currency, {
                        maximumFractionDigits: 0,
                      })}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="text-[12px] font-medium text-ink-2">
                      Open Value
                    </span>
                    <span className="num mt-0.5 text-[16px] font-semibold tracking-[-0.015em] text-ink">
                      {formatMoney(totalValue, currency, {
                        maximumFractionDigits: 0,
                      })}
                    </span>
                    <span className="text-[12px] text-ink-3">
                      {slices.length} group{slices.length === 1 ? "" : "s"}
                    </span>
                  </>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                const next = !isExpanded;
                setIsExpanded(next);
                onExpandedChange?.(next);
              }}
              aria-expanded={isExpanded}
              className="inline-flex h-8.5 items-center gap-1.5 rounded-[10px] border border-line bg-surface-2 px-3 text-[12px] font-medium text-ink-2 transition-colors hover:border-ink-3/60 hover:text-ink"
            >
              <span>
                {isExpanded
                  ? "Hide breakdown"
                  : `Show breakdown (${slices.length})`}
              </span>
              <ChevronDown
                size={16}
                strokeWidth={1.75}
                aria-hidden="true"
                className={`transition-transform duration-150 ${
                  isExpanded ? "rotate-180" : ""
                }`}
              />
            </button>
          </div>

          <AnimatePresence initial={false}>
            {isExpanded && (
              <motion.div
                key="allocation-breakdown"
                initial={{ opacity: 0, height: 0 }}
                animate={{
                  opacity: 1,
                  height: "auto",
                  transition: { ...springSmooth, opacity: fadeQuick },
                }}
                exit={{
                  opacity: 0,
                  height: 0,
                  transition: { ...fadeQuick, opacity: { duration: 0.1 } },
                }}
                className="overflow-hidden"
              >
                {/* Interactive Legend List */}
                <ul className="space-y-1 border-t border-line pt-3">
                  {segments.map((seg) => {
                    const isHighlighted = activeKey === seg.key;
                    return (
                      <li key={seg.key}>
                        <button
                          type="button"
                          onMouseEnter={() => setActiveKey(seg.key)}
                          onMouseLeave={() => setActiveKey(null)}
                          onFocus={() => setActiveKey(seg.key)}
                          onBlur={() => setActiveKey(null)}
                          onClick={() =>
                            setActiveKey((prev) =>
                              prev === seg.key ? null : seg.key,
                            )
                          }
                          className={`flex w-full items-center justify-between gap-3 rounded-[10px] px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                            isHighlighted
                              ? "bg-surface-2 text-ink"
                              : "text-ink-2 hover:bg-surface-2 hover:text-ink"
                          }`}
                        >
                          <span className="flex min-w-0 flex-1 items-center gap-2.5">
                            <span
                              className={`h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-line transition-transform duration-150 ${
                                isHighlighted ? "scale-115" : ""
                              }`}
                              style={{ backgroundColor: seg.color }}
                            />
                            <span className="truncate font-medium text-ink">
                              {seg.label}
                            </span>
                          </span>
                          <span className="num shrink-0 pl-1 text-[12.5px]">
                            <span className="font-semibold text-ink">
                              {formatPercent(seg.percent)}
                            </span>
                            <span className="ml-2 text-ink-2">
                              {formatMoney(seg.valueInBase, currency, {
                                maximumFractionDigits: 0,
                              })}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>

                {dimension === "sector" && hasMissingSector && (
                  <p className="mt-3 text-[12px] text-ink-3">
                    ETFs, REITs, and equities without a Finnhub sector tag are
                    grouped by fund type or labeled Unclassified.
                  </p>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* Accessible screen-reader data table */}
      <table className="sr-only">
        <caption>Portfolio allocation by {dimension}</caption>
        <thead>
          <tr>
            <th>Group</th>
            <th>Value ({currency})</th>
            <th>Weight</th>
          </tr>
        </thead>
        <tbody>
          {slices.map((s) => (
            <tr key={s.key}>
              <td>{s.label}</td>
              <td>{s.valueInBase}</td>
              <td>{s.percent}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
