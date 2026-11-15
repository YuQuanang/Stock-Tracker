"use client";

import {
  AlertCircle,
  Bell,
  Calculator,
  Loader2,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { GainBadge } from "@/components/ui/gain-badge";
import { Sheet } from "@/components/ui/sheet";
import { formatMoney, formatPercent, formatQuantity } from "@/lib/format";
import type { PaperSimulationPreview } from "@/lib/services/watchlist";
import { formatSymbolForDisplay } from "@/lib/transactions/form-logic";
import type { ValuedWatchlistItem } from "@/lib/watchlist/valuation";

interface SimulateAlertsSheetProps {
  item: ValuedWatchlistItem | null;
  defaultBenchmark: string;
  onClose: () => void;
  onSaved: () => void;
}

function getOneYearAgoSgtIso(): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function SimulateAlertsSheet({
  item,
  defaultBenchmark,
  onClose,
  onSaved,
}: SimulateAlertsSheetProps) {
  if (!item) {
    return null;
  }

  const displaySymbol = formatSymbolForDisplay(item.symbol);

  return (
    <Sheet
      isOpen={Boolean(item)}
      onClose={onClose}
      title={`${displaySymbol} — Simulate & Alerts`}
      description={
        item.name
          ? `${item.name} · Configure target price alerts or test an equal-dollar past entry against ${formatSymbolForDisplay(defaultBenchmark)}.`
          : `Configure target price alerts or test an equal-dollar past entry against ${formatSymbolForDisplay(defaultBenchmark)}.`
      }
      maxWidthClass="max-w-xl"
    >
      <SimulateAlertsForm
        key={`${item.portfolioId}::${item.instrumentId}`}
        item={item}
        defaultBenchmark={defaultBenchmark}
        onClose={onClose}
        onSaved={onSaved}
      />
    </Sheet>
  );
}

function SimulateAlertsForm({
  item,
  defaultBenchmark,
  onClose,
  onSaved,
}: {
  item: ValuedWatchlistItem;
  defaultBenchmark: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [priceWhenAdded, setPriceWhenAdded] = useState(
    item.priceWhenAdded ?? "",
  );
  const [alertAbove, setAlertAbove] = useState(item.alertAbove ?? "");
  const [alertBelow, setAlertBelow] = useState(item.alertBelow ?? "");

  const [paperEntryDate, setPaperEntryDate] = useState(
    item.paperEntryDate ?? getOneYearAgoSgtIso(),
  );
  const [paperAmount, setPaperAmount] = useState(item.paperAmount ?? "1000");
  const [clearPaper, setClearPaper] = useState(false);

  const [preview, setPreview] = useState<PaperSimulationPreview | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const hasExistingSimulation = Boolean(
    item.paperEntryDate && item.paperAmount && item.paperShares && !clearPaper,
  );
  const isCrypto = item.assetType === "crypto";

  async function handleRunPreview() {
    setPreviewError(null);
    setSaveError(null);

    if (!paperEntryDate.trim() || !paperAmount.trim()) {
      setPreviewError("Enter both an entry date and an investment amount.");
      return;
    }

    setIsPreviewLoading(true);
    try {
      const params = new URLSearchParams({
        symbol: item.symbol,
        entryDate: paperEntryDate.trim(),
        amount: paperAmount.trim(),
        benchmark: defaultBenchmark,
      });
      const response = await fetch(`/api/watchlists/simulate?${params}`);
      const data = await response.json();

      if (!response.ok) {
        setPreview(null);
        setPreviewError(data.error ?? "Unable to simulate this entry date.");
        setIsPreviewLoading(false);
        return;
      }

      setClearPaper(false);
      setPreview(data.preview as PaperSimulationPreview);
      setIsPreviewLoading(false);
    } catch {
      setPreviewError("Network error while fetching historical prices.");
      setIsPreviewLoading(false);
    }
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    setSaveError(null);
    setIsSaving(true);

    try {
      const shouldSaveSimulation =
        !isCrypto &&
        !clearPaper &&
        (Boolean(preview) ||
          hasExistingSimulation ||
          (paperEntryDate !== (item.paperEntryDate ?? getOneYearAgoSgtIso()) &&
            paperAmount.trim().length > 0));

      const body: Record<string, unknown> = {
        priceWhenAdded: priceWhenAdded.trim() || null,
        alertAbove: alertAbove.trim() || null,
        alertBelow: alertBelow.trim() || null,
      };

      if (clearPaper) {
        body.clearPaperPosition = true;
      } else if (shouldSaveSimulation) {
        body.paperEntryDate = paperEntryDate.trim();
        body.paperAmount = paperAmount.trim();
        if (
          preview &&
          preview.entryDate === paperEntryDate.trim() &&
          preview.amount === paperAmount.trim()
        ) {
          body.paperShares = preview.comparison.paperShares;
        }
      }

      const response = await fetch(
        `/api/watchlists/items/${item.portfolioId}/${item.instrumentId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );

      const data = await response.json();
      if (!response.ok) {
        setSaveError(data.error ?? "Unable to save watchlist updates.");
        setIsSaving(false);
        return;
      }

      onSaved();
      onClose();
    } catch {
      setSaveError("Network error while saving changes.");
      setIsSaving(false);
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-5">
      {/* Live quote strip */}
      <div className="flex items-center justify-between gap-4 rounded-[12px] border border-line bg-surface-2 px-4 py-3">
        <div>
          <p className="text-[12px] font-medium text-ink-2">
            Current price ·{" "}
            <span className="font-mono text-ink-3">{item.freshnessLabel}</span>
          </p>
          <p className="num mt-0.5 text-[22px] font-semibold tracking-tight text-ink">
            {item.unitPrice
              ? formatMoney(item.unitPrice, item.currency)
              : "Unavailable"}
          </p>
        </div>
        {item.dayChange !== null && item.dayChangePercent !== null && (
          <GainBadge
            amount={item.dayChange}
            currency={item.currency}
            percent={item.dayChangePercent}
            pill
          />
        )}
      </div>

      {/* Price Alerts */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-accent" aria-hidden="true" />
          <h3 className="text-[14px] font-semibold text-ink">
            Price alerts &amp; tracking baseline
          </h3>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label
              htmlFor="sim-alert-above"
              className="mb-1.5 block text-[12.5px] font-medium text-ink-2"
            >
              Alert above ({item.currency})
            </label>
            <input
              id="sim-alert-above"
              type="text"
              inputMode="decimal"
              value={alertAbove}
              onChange={(e) => setAlertAbove(e.target.value)}
              placeholder="No upper alert"
              className="field-input num"
            />
          </div>

          <div>
            <label
              htmlFor="sim-alert-below"
              className="mb-1.5 block text-[12.5px] font-medium text-ink-2"
            >
              Alert below ({item.currency})
            </label>
            <input
              id="sim-alert-below"
              type="text"
              inputMode="decimal"
              value={alertBelow}
              onChange={(e) => setAlertBelow(e.target.value)}
              placeholder="No lower alert"
              className="field-input num"
            />
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <label
                htmlFor="sim-price-added"
                className="block text-[12.5px] font-medium text-ink-2"
              >
                Added price
              </label>
              {item.unitPrice && (
                <button
                  type="button"
                  onClick={() => setPriceWhenAdded(item.unitPrice ?? "")}
                  className="cursor-pointer text-[11.5px] font-medium text-accent hover:underline"
                >
                  Use current
                </button>
              )}
            </div>
            <input
              id="sim-price-added"
              type="text"
              inputMode="decimal"
              value={priceWhenAdded}
              onChange={(e) => setPriceWhenAdded(e.target.value)}
              placeholder="Optional baseline"
              className="field-input num"
            />
          </div>
        </div>
      </section>

      {/* "If I had bought it" Paper Simulator */}
      <section className="space-y-3 border-t border-line pt-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Calculator className="h-4 w-4 text-accent" aria-hidden="true" />
            <h3 className="text-[14px] font-semibold text-ink">
              If I had bought it (Paper simulator)
            </h3>
          </div>
          {hasExistingSimulation && (
            <button
              type="button"
              onClick={() => {
                setClearPaper(true);
                setPreview(null);
              }}
              className="inline-flex cursor-pointer items-center gap-1 text-[12px] font-medium text-loss hover:underline"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Clear simulation
            </button>
          )}
        </div>

        {isCrypto ? (
          <p className="text-[13px] text-ink-2">
            Historical simulation is unavailable for crypto symbols.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
              <div>
                <label
                  htmlFor="sim-entry-date"
                  className="mb-1.5 block text-[12.5px] font-medium text-ink-2"
                >
                  Hypothetical buy date
                </label>
                <input
                  id="sim-entry-date"
                  type="date"
                  value={paperEntryDate}
                  onChange={(e) => {
                    setPaperEntryDate(e.target.value);
                    setClearPaper(false);
                    setPreview(null);
                  }}
                  className="field-input num"
                />
              </div>

              <div>
                <label
                  htmlFor="sim-amount"
                  className="mb-1.5 block text-[12.5px] font-medium text-ink-2"
                >
                  Amount invested ({item.currency})
                </label>
                <input
                  id="sim-amount"
                  type="text"
                  inputMode="decimal"
                  value={paperAmount}
                  onChange={(e) => {
                    setPaperAmount(e.target.value);
                    setClearPaper(false);
                    setPreview(null);
                  }}
                  placeholder="1000"
                  className="field-input num"
                />
              </div>

              <Button
                type="button"
                variant="secondary"
                className="h-11 px-4 text-[14px]"
                onClick={handleRunPreview}
                disabled={isPreviewLoading}
              >
                {isPreviewLoading ? (
                  <>
                    <Loader2
                      className="h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                    Simulating...
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" aria-hidden="true" />
                    Simulate
                  </>
                )}
              </Button>
            </div>

            {previewError && (
              <div
                role="alert"
                className="flex items-center gap-2 rounded-[12px] bg-loss/10 px-3.5 py-2.5 text-[13px] text-loss"
              >
                <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{previewError}</span>
              </div>
            )}

            {preview ? (
              <SimulationResultCard
                symbol={item.symbol}
                currency={preview.currency}
                entryDate={preview.assetEntryDateUsed}
                amount={preview.amount}
                shares={preview.comparison.paperShares}
                entryPrice={preview.comparison.assetEntryPrice}
                currentValue={preview.comparison.assetCurrentValue}
                gain={preview.comparison.assetGain}
                gainPercent={preview.comparison.assetGainPercent}
                benchmarkName={preview.benchmarkName}
                benchmarkGainPercent={preview.comparison.benchmarkGainPercent}
                excessReturnPercent={preview.comparison.excessReturnPercent}
              />
            ) : hasExistingSimulation &&
              item.paperAmount &&
              item.paperShares &&
              item.paperCurrentValue &&
              item.paperGain &&
              item.paperGainPercent &&
              item.paperEntryPriceImplied &&
              item.paperEntryDate ? (
              <SimulationResultCard
                symbol={item.symbol}
                currency={item.currency}
                entryDate={item.paperEntryDate}
                amount={item.paperAmount}
                shares={item.paperShares}
                entryPrice={item.paperEntryPriceImplied}
                currentValue={item.paperCurrentValue}
                gain={item.paperGain}
                gainPercent={item.paperGainPercent}
                benchmarkName={
                  item.paperBenchmark?.benchmarkName ?? defaultBenchmark
                }
                benchmarkGainPercent={
                  item.paperBenchmark?.benchmarkGainPercent ?? null
                }
                excessReturnPercent={item.paperExcessReturnPercent}
              />
            ) : clearPaper ? (
              <p className="text-[12.5px] text-ink-2">
                Simulation will be removed when you save.
              </p>
            ) : (
              <p className="text-[12.5px] text-ink-2">
                Select a date and amount, then tap <strong>Simulate</strong>{" "}
                to calculate exact shares and compare against{" "}
                {defaultBenchmark}.
              </p>
            )}
          </>
        )}
      </section>

      {saveError && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-[10px] bg-loss/10 px-3.5 py-2.5 text-[13px] text-loss"
        >
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{saveError}</span>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
        <Button
          type="button"
          variant="ghost"
          onClick={onClose}
          className="px-4 py-2 text-[14px]"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={isSaving}
          className="px-4 py-2 text-[14px]"
        >
          {isSaving ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Saving...
            </>
          ) : (
            "Save changes"
          )}
        </Button>
      </div>
    </form>
  );
}

function SimulationResultCard(props: {
  symbol: string;
  currency: "USD" | "SGD";
  entryDate: string;
  amount: string;
  shares: string;
  entryPrice: string;
  currentValue: string;
  gain: string;
  gainPercent: string;
  benchmarkName: string;
  benchmarkGainPercent: string | null;
  excessReturnPercent: string | null;
}) {
  const excessNum = props.excessReturnPercent
    ? Number(props.excessReturnPercent)
    : null;

  return (
    <div className="space-y-2.5 rounded-[12px] border border-line bg-surface-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="num text-[12.5px] font-medium text-ink-2">
            Bought {formatQuantity(props.shares)} sh of{" "}
            <span className="font-mono font-semibold text-ink">
              {formatSymbolForDisplay(props.symbol)}
            </span>{" "}
            on <span className="font-mono">{props.entryDate}</span> @{" "}
            {formatMoney(props.entryPrice, props.currency)}
          </p>
          <p className="num mt-0.5 text-[19px] font-semibold tracking-tight text-ink">
            {formatMoney(props.currentValue, props.currency)}
            <span className="ml-2 text-[12.5px] font-normal text-ink-2">
              from {formatMoney(props.amount, props.currency)}
            </span>
          </p>
        </div>
        <GainBadge
          amount={props.gain}
          currency={props.currency}
          percent={props.gainPercent}
          pill
        />
      </div>

      {props.benchmarkGainPercent !== null && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2.5 text-[12.5px]">
          <span className="num text-ink-2">
            Same {formatMoney(props.amount, props.currency)} in{" "}
            <strong className="font-semibold text-ink">
              {props.benchmarkName}
            </strong>
            : {formatPercent(props.benchmarkGainPercent)}
          </span>
          {excessNum !== null && (
            <span
              className={`num font-semibold ${
                excessNum >= 0 ? "text-gain" : "text-loss"
              }`}
            >
              {excessNum >= 0 ? "Beat benchmark by +" : "Trailed benchmark by "}
              {formatPercent(props.excessReturnPercent, { signed: false })}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
