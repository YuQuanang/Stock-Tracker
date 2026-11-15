"use client";

import { LayoutGroup, motion } from "framer-motion";
import { springSnappy } from "@/lib/motion";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  ariaLabel: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (nextValue: T) => void;
  layoutId: string;
  /** Stretches equal-width segments across 100% of container width (Apple sheet style). */
  fullWidth?: boolean;
  /** Compact `"sm"` density is tailored for chart range bars (`1M`, `1Y`, `MAX`). */
  size?: "sm" | "md";
}

/**
 * Apple HIG segmented control with isolated `<LayoutGroup>`, scale-corrected
 * pill corner radius, tactile press micro-scale, and true dark/light elevation.
 */
export function SegmentedControl<T extends string>({
  ariaLabel,
  options,
  value,
  onChange,
  layoutId,
  fullWidth = false,
  size = "md",
}: SegmentedControlProps<T>) {
  const isSmall = size === "sm";
  const trackRadius = isSmall ? "rounded-[10px] p-0.5" : "rounded-[10px] p-[3px]";
  const thumbBorderRadius = isSmall ? 8 : 8;

  return (
    <LayoutGroup id={layoutId}>
      <div
        role="radiogroup"
        aria-label={ariaLabel}
        style={{
          backgroundColor: "var(--seg-track)",
          ...(fullWidth
            ? { gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }
            : {}),
        }}
        className={
          fullWidth
            ? `grid w-full border border-line ${trackRadius}`
            : `no-scrollbar inline-flex max-w-full overflow-x-auto border border-line ${trackRadius}`
        }
      >
        {options.map((option) => {
          const isSelected = option.value === value;
          return (
            <motion.button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={isSelected}
              whileTap={{ scale: 0.97 }}
              transition={springSnappy}
              onClick={() => onChange(option.value)}
              className={`relative flex shrink-0 items-center justify-center whitespace-nowrap font-medium tracking-[-0.01em] transition-colors duration-150 ${
                isSmall
                  ? "num h-6.5 px-2 text-[11.5px] sm:px-2.5"
                  : "h-8 px-3 text-[13px]"
              } ${isSelected ? "text-ink" : "text-ink-2 hover:text-ink"}`}
            >
              {isSelected && (
                <motion.span
                  layoutId="seg-thumb"
                  layout
                  transition={springSnappy}
                  style={{
                    borderRadius: thumbBorderRadius,
                    backgroundColor: "var(--seg-thumb)",
                    borderColor: "var(--seg-thumb-border)",
                    boxShadow: "var(--seg-thumb-shadow)",
                  }}
                  className="pointer-events-none absolute inset-0 border"
                />
              )}
              <span className="relative z-10">{option.label}</span>
            </motion.button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}
