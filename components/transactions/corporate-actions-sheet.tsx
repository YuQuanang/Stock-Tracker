"use client";

import { Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import type { EnrichedCorporateAction } from "@/lib/services/ledger";

interface CorporateActionsSheetProps {
  isOpen: boolean;
  onClose: () => void;
  actions: EnrichedCorporateAction[];
  onChanged: () => void;
}

/**
 * Manual stock-split manager (section 3 requirement).
 * Splits scale open FIFO lots on `exDate` without altering stored CSV rows.
 */
export function CorporateActionsSheet({
  isOpen,
  onClose,
  actions,
  onChanged,
}: CorporateActionsSheetProps) {
  const [symbol, setSymbol] = useState("");
  const [exDate, setExDate] = useState("2024-06-10");
  const [ratioNumerator, setRatioNumerator] = useState("10");
  const [ratioDenominator, setRatioDenominator] = useState("1");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleAdd(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const response = await fetch("/api/corporate-actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          symbol: symbol.trim(),
          exDate,
          ratioNumerator: Number(ratioNumerator),
          ratioDenominator: Number(ratioDenominator),
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setErrorMessage(body?.error ?? "Could not add stock split.");
        return;
      }

      setSymbol("");
      onChanged();
    } catch {
      setErrorMessage("Could not reach the server.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDelete(id: string): Promise<void> {
    setErrorMessage(null);
    const response = await fetch(`/api/corporate-actions/${id}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      setErrorMessage(
        body?.error ??
          "Removing this split would cause a later sell to exceed shares held.",
      );
      return;
    }
    onChanged();
  }

  return (
    <Sheet
      isOpen={isOpen}
      onClose={onClose}
      maxWidthClass="sm:max-w-[480px]"
      title="Stock Splits"
      description="Adjusts open share counts and per-share cost basis on the ex-date."
    >
      <form onSubmit={handleAdd} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label
              htmlFor="split-symbol"
              className="mb-1.5 block h-5 truncate text-[13px] font-medium leading-5 text-ink-2"
            >
              Symbol
            </label>
            <input
              id="split-symbol"
              type="text"
              required
              placeholder="NVDA"
              value={symbol}
              onChange={(event) => setSymbol(event.target.value)}
              className="field-input font-mono"
            />
          </div>

          <div>
            <label
              htmlFor="split-date"
              className="mb-1.5 block h-5 truncate text-[13px] font-medium leading-5 text-ink-2"
            >
              Ex-date
            </label>
            <input
              id="split-date"
              type="date"
              required
              value={exDate}
              onChange={(event) => setExDate(event.target.value)}
              className="field-input num"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label
              htmlFor="split-num"
              className="mb-1.5 block h-5 truncate text-[13px] font-medium leading-5 text-ink-2"
            >
              New shares
            </label>
            <input
              id="split-num"
              type="number"
              min={1}
              required
              value={ratioNumerator}
              onChange={(event) => setRatioNumerator(event.target.value)}
              className="field-input num"
            />
          </div>

          <div>
            <label
              htmlFor="split-den"
              className="mb-1.5 block h-5 truncate text-[13px] font-medium leading-5 text-ink-2"
            >
              Old shares
            </label>
            <input
              id="split-den"
              type="number"
              min={1}
              required
              value={ratioDenominator}
              onChange={(event) => setRatioDenominator(event.target.value)}
              className="field-input num"
            />
          </div>
        </div>

        {errorMessage && (
          <p role="alert" className="text-[13.5px] text-loss">
            {errorMessage}
          </p>
        )}

        <div className="flex justify-end">
          <Button type="submit" disabled={isSubmitting} className="w-full sm:w-auto">
            {isSubmitting ? "Adding…" : "Add Split"}
          </Button>
        </div>
      </form>

      <div className="mt-5 border-t border-line pt-4">
        <h3 className="mb-2 text-[12px] font-medium text-ink-2">
          Recorded splits
        </h3>
        {actions.length === 0 ? (
          <p className="py-3 text-[13.5px] text-ink-2">
            No manual stock splits recorded.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {actions.map((action) => (
              <li
                key={action.id}
                className="flex items-center justify-between py-2.5 text-[14px]"
              >
                <div>
                  <span className="font-mono font-semibold">{action.symbol}</span>
                  <span className="ml-2 num text-ink-2">
                    {action.ratioNumerator}:{action.ratioDenominator} on{" "}
                    <span className="font-mono">{action.exDate}</span>
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleDelete(action.id)}
                  aria-label={`Remove split for ${action.symbol}`}
                  className="rounded-[8px] p-1.5 text-ink-2 transition-colors hover:bg-surface-2 hover:text-loss"
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  );
}
