"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Info } from "lucide-react";

interface MetricTooltipProps {
  label: string;
  explanation: string;
}

/**
 * Accessible info popover explaining complex portfolio metrics (TWR, XIRR,
 * Sharpe, Beta, Alpha, Drawdown) in plain English without cluttering cards.
 */
export function MetricTooltip({ label, explanation }: MetricTooltipProps) {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handleOutside(event: MouseEvent | KeyboardEvent) {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") {
          setOpen(false);
        }
        return;
      }
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("keydown", handleOutside);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("keydown", handleOutside);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative inline-flex items-center">
      <button
        type="button"
        aria-label={`Explain ${label}`}
        aria-expanded={open}
        aria-controls={open ? tooltipId : undefined}
        onClick={() => setOpen((prev) => !prev)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="inline-flex h-5 w-5 items-center justify-center rounded-[8px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Info size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>

      {open && (
        <div
          id={tooltipId}
          role="tooltip"
          className="absolute bottom-full left-1/2 z-40 mb-2 w-64 -translate-x-1/2 rounded-[12px] border border-line bg-surface-2 p-3 text-[12px] leading-[1.45] font-normal text-ink shadow-raised"
        >
          <p className="font-semibold text-ink">{label}</p>
          <p className="mt-0.5 text-ink-2">{explanation}</p>
        </div>
      )}
    </div>
  );
}

