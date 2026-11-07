"use client";

import { motion } from "framer-motion";
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
}

/** Tactile Apple-style segmented control with a spring-animated thumb. */
export function SegmentedControl<T extends string>({
  ariaLabel,
  options,
  value,
  onChange,
  layoutId,
  fullWidth = false,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      style={
        fullWidth
          ? { gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }
          : undefined
      }
      className={
        fullWidth
          ? "grid w-full rounded-[10px] bg-field-bg p-0.75"
          : "inline-flex max-w-full overflow-x-auto rounded-[10px] bg-field-bg p-0.75"
      }
    >
      {options.map((option) => {
        const isSelected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            onClick={() => onChange(option.value)}
            className={`relative flex h-8 items-center justify-center whitespace-nowrap rounded-[8px] px-3 text-[13px] font-medium tracking-[-0.01em] transition-colors duration-150 ${
              isSelected ? "text-ink" : "text-ink-2 hover:text-ink"
            }`}
          >
            {isSelected && (
              <motion.span
                layoutId={layoutId}
                transition={springSnappy}
                className="absolute inset-0 rounded-[8px] border border-line/60 bg-surface shadow-xs"
              />
            )}
            <span className="relative z-10">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
