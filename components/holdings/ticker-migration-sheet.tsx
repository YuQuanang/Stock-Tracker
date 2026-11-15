"use client";

import { useState, type FormEvent } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import type { SgxTickerTransition } from "@/lib/market-data/sgx-transitions";

export interface TickerMigrationTarget {
  instrumentId: string;
  transition: SgxTickerTransition;
  defaultApplyConsolidation: boolean;
}

interface TickerMigrationSheetProps {
  target: TickerMigrationTarget | null;
  onClose: () => void;
  onMigrated: (targetSymbol: string) => void;
}

export function TickerMigrationSheet({
  target,
  onClose,
  onMigrated,
}: TickerMigrationSheetProps) {
  const [applyConsolidation, setApplyConsolidation] = useState(
    target?.defaultApplyConsolidation ?? false,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!target) {
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/instruments/${encodeURIComponent(target.instrumentId)}/migrate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetSymbol: target.transition.newSymbol,
            targetName: target.transition.companyName,
            applyConsolidationSplit: applyConsolidation,
            exDate: target.transition.effectiveDate,
            ratioNumerator: target.transition.ratioNumerator,
            ratioDenominator: target.transition.ratioDenominator,
          }),
        },
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Could not update ticker symbol.");
        return;
      }

      const nextSymbol =
        data?.instrument?.symbol ?? target.transition.newSymbol;
      onMigrated(nextSymbol);
    } catch {
      setError("Network error updating ticker symbol.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Sheet
      isOpen={target !== null}
      onClose={onClose}
      title={
        target
          ? `Update ${target.transition.oldSymbol} to ${target.transition.newSymbol}`
          : "Update ticker symbol"
      }
      description={target?.transition.reason}
    >
      {target && (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="flex items-center justify-between gap-3 rounded-[12px] border border-line bg-field-bg px-4 py-3">
            <div>
              <p className="text-[12px] font-medium text-ink-3">Retired</p>
              <p className="font-mono text-[15px] font-semibold text-ink-2">
                {target.transition.oldSymbol}
              </p>
            </div>
            <ArrowRight
              size={16}
              strokeWidth={1.75}
              className="text-ink-3"
              aria-hidden="true"
            />
            <div className="text-right">
              <p className="text-[12px] font-medium text-ink-3">
                Active SGX ticker
              </p>
              <p className="font-mono text-[15px] font-semibold text-accent">
                {target.transition.newSymbol}
              </p>
            </div>
          </div>

          <label className="flex cursor-pointer items-start gap-3 rounded-[12px] border border-line bg-field-bg p-3.5">
            <input
              type="checkbox"
              checked={applyConsolidation}
              onChange={(e) => setApplyConsolidation(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded accent-accent"
            />
            <div className="text-[13.5px]">
              <span className="font-medium text-ink">
                Apply {target.transition.ratioDenominator}-for-
                {target.transition.ratioNumerator} consolidation (ex-date{" "}
                <span className="font-mono">
                  {target.transition.effectiveDate}
                </span>
                )
              </span>
              <p className="mt-0.5 text-[12.5px] leading-snug text-ink-2">
                Scales open units held before {target.transition.effectiveDate}{" "}
                by {target.transition.ratioNumerator}/
                {target.transition.ratioDenominator} while keeping total cost
                basis unchanged so consolidated units match live{" "}
                {target.transition.newSymbol} prices. Leave unchecked if you
                already recorded the consolidation or only track a watchlist
                item.
              </p>
            </div>
          </label>

          {error && (
            <p className="rounded-[10px] bg-loss/10 px-3 py-2 text-[13px] text-loss">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting
                ? "Updating…"
                : `Switch to ${target.transition.newSymbol}`}
            </Button>
          </div>
        </form>
      )}
    </Sheet>
  );
}

