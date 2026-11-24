"use client";

import { AlertCircle, ChevronDown, Loader2 } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import type { Portfolio } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { formatMoney, formatQuantity } from "@/lib/format";
import { formatSymbolForDisplay } from "@/lib/transactions/form-logic";

export interface EditHoldingPortfolioPosition {
  portfolioId: string;
  portfolioName: string;
  sharesHeld: string;
  averageCostPerShare: string | null;
  openCostBasis: string;
  effectiveFxRateToSgd?: string | null;
}

export interface EditHoldingTarget {
  symbol: string;
  name: string | null;
  exchangeCode: string | null;
  currency: string;
  initialPortfolioId: string;
  positionsByPortfolio: EditHoldingPortfolioPosition[];
}

interface EditHoldingSheetProps {
  isOpen: boolean;
  target: EditHoldingTarget | null;
  portfolios: Portfolio[];
  currentUsdToSgdRate?: string | null;
  onClose: () => void;
  onSaved: () => void;
}

function toCleanNumericInput(
  raw: string | null | undefined,
  maxFractionDigits: number,
): string {
  if (!raw) {
    return "";
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  if (parsed === 0) {
    return "0";
  }
  return Number(parsed.toFixed(maxFractionDigits)).toString();
}

export function EditHoldingSheet({
  isOpen,
  target,
  portfolios,
  currentUsdToSgdRate = null,
  onClose,
  onSaved,
}: EditHoldingSheetProps) {
  if (!isOpen || !target) {
    return null;
  }

  return (
    <Sheet
      isOpen={isOpen}
      onClose={onClose}
      maxWidthClass="sm:max-w-[480px]"
      title={`Edit holding · ${formatSymbolForDisplay(target.symbol)}`}
      description={
        target.name
          ? `${target.name} · Update your current share count and average cost directly without adding manual transactions.`
          : "Update your current share count and average cost directly without adding manual transactions."
      }
    >
      <EditHoldingForm
        key={`${target.symbol}-${target.initialPortfolioId}`}
        target={target}
        portfolios={portfolios}
        currentUsdToSgdRate={currentUsdToSgdRate}
        onClose={onClose}
        onSaved={onSaved}
      />
    </Sheet>
  );
}

function EditHoldingForm({
  target,
  portfolios,
  currentUsdToSgdRate,
  onClose,
  onSaved,
}: {
  target: EditHoldingTarget;
  portfolios: Portfolio[];
  currentUsdToSgdRate: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const holdingsPortfolios = useMemo(
    () => portfolios.filter((p) => p.type === "holdings"),
    [portfolios],
  );

  const positionByPortfolioId = useMemo(() => {
    const map = new Map<string, EditHoldingPortfolioPosition>();
    for (const pos of target.positionsByPortfolio) {
      map.set(pos.portfolioId, pos);
    }
    return map;
  }, [target.positionsByPortfolio]);

  const initialPortfolioId = holdingsPortfolios.some(
    (p) => p.id === target.initialPortfolioId,
  )
    ? target.initialPortfolioId
    : (holdingsPortfolios[0]?.id ?? "");

  const initialPos = positionByPortfolioId.get(initialPortfolioId);

  const [portfolioId, setPortfolioId] = useState<string>(initialPortfolioId);
  const [sharesInput, setSharesInput] = useState<string>(() =>
    toCleanNumericInput(initialPos?.sharesHeld ?? "0", 8),
  );
  const [avgCostInput, setAvgCostInput] = useState<string>(() =>
    toCleanNumericInput(initialPos?.averageCostPerShare, 6),
  );
  const [fxRateInput, setFxRateInput] = useState<string>(() =>
    toCleanNumericInput(
      initialPos?.effectiveFxRateToSgd ?? currentUsdToSgdRate,
      6,
    ),
  );
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isNonSgd = target.currency.toUpperCase() !== "SGD";
  const activePortfolio = holdingsPortfolios.find((p) => p.id === portfolioId);
  const currentPos = positionByPortfolioId.get(portfolioId);
  const currentSharesNum = Number(currentPos?.sharesHeld ?? 0);

  function handlePortfolioChange(nextPortfolioId: string): void {
    setPortfolioId(nextPortfolioId);
    const pos = positionByPortfolioId.get(nextPortfolioId);
    setSharesInput(toCleanNumericInput(pos?.sharesHeld ?? "0", 8));
    setAvgCostInput(toCleanNumericInput(pos?.averageCostPerShare, 6));
    setFxRateInput(
      toCleanNumericInput(
        pos?.effectiveFxRateToSgd ?? currentUsdToSgdRate,
        6,
      ),
    );
    setError(null);
  }

  const parsedShares = Number(sharesInput.trim());
  const sharesValid =
    sharesInput.trim() !== "" &&
    Number.isFinite(parsedShares) &&
    parsedShares >= 0;

  const isClearingPosition = sharesValid && parsedShares === 0;

  const parsedAvgCost =
    avgCostInput.trim() === "" ? 0 : Number(avgCostInput.trim());
  const avgCostValid =
    isClearingPosition ||
    (avgCostInput.trim() !== "" &&
      Number.isFinite(parsedAvgCost) &&
      parsedAvgCost >= 0);

  const parsedFx =
    fxRateInput.trim() === "" ? null : Number(fxRateInput.trim());
  const fxValid =
    !isNonSgd ||
    isClearingPosition ||
    parsedFx === null ||
    (Number.isFinite(parsedFx) && parsedFx > 0);

  const previewOpenCost =
    sharesValid && avgCostValid && !isClearingPosition
      ? parsedShares * parsedAvgCost
      : 0;
  const previewOpenCostSgd =
    isNonSgd && parsedFx && parsedFx > 0 ? previewOpenCost * parsedFx : null;
  const sharesDelta = sharesValid ? parsedShares - currentSharesNum : null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    if (!portfolioId) {
      setError("Please select a holdings portfolio.");
      return;
    }
    if (!sharesValid) {
      setError("Enter a valid non-negative share count.");
      return;
    }
    if (!avgCostValid) {
      setError("Enter a valid non-negative average cost per share.");
      return;
    }
    if (!fxValid) {
      setError("Exchange rate to SGD must be greater than zero.");
      return;
    }

    setIsSaving(true);
    try {
      const response = await fetch("/api/holdings/adjust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          portfolioId,
          symbol: target.symbol,
          instrumentName: target.name,
          exchangeCode: target.exchangeCode,
          currency: target.currency,
          targetShares: sharesInput.trim(),
          targetAverageCost: isClearingPosition ? "0" : avgCostInput.trim(),
          fxRateToSgd:
            isNonSgd && !isClearingPosition && fxRateInput.trim() !== ""
              ? fxRateInput.trim()
              : null,
        }),
      });

      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;

      if (!response.ok) {
        setError(body?.error ?? "Unable to update holding.");
        return;
      }

      onSaved();
      onClose();
    } catch {
      setError("Network error while saving holding changes.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
      {/* Portfolio Selector */}
      <div>
        <label
          htmlFor="edit-holding-portfolio"
          className="mb-1.5 block text-[13px] font-medium text-ink-2"
        >
          Portfolio
        </label>
        {holdingsPortfolios.length > 1 ? (
          <div className="relative">
            <select
              id="edit-holding-portfolio"
              value={portfolioId}
              disabled={isSaving}
              onChange={(event) => handlePortfolioChange(event.target.value)}
              className="field-input h-10 appearance-none bg-field-bg pr-9 text-[14px]"
            >
              {holdingsPortfolios.map((pf) => {
                const pos = positionByPortfolioId.get(pf.id);
                const sh = pos ? Number(pos.sharesHeld) : 0;
                return (
                  <option key={pf.id} value={pf.id}>
                    {pf.name}
                    {sh > 0 ? ` (${formatQuantity(pos!.sharesHeld)} sh)` : ""}
                  </option>
                );
              })}
            </select>
            <ChevronDown
              size={16}
              strokeWidth={2}
              aria-hidden="true"
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-2"
            />
          </div>
        ) : (
          <div className="rounded-[10px] border border-line bg-surface-2/60 px-3.5 py-2.5 text-[14px] font-medium text-ink">
            {activePortfolio?.name ?? "No holdings portfolio"}
          </div>
        )}
      </div>

      {/* Shares Held & Average Cost */}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <label
              htmlFor="edit-holding-shares"
              className="text-[13px] font-medium text-ink-2"
            >
              Shares held
            </label>
            {currentSharesNum > 0 && sharesInput.trim() !== "0" && (
              <button
                type="button"
                onClick={() => setSharesInput("0")}
                className="text-[11.5px] font-medium text-ink-2 transition-colors hover:text-loss"
              >
                Clear (0)
              </button>
            )}
          </div>
          <input
            id="edit-holding-shares"
            type="text"
            inputMode="decimal"
            autoFocus
            value={sharesInput}
            onChange={(event) => setSharesInput(event.target.value)}
            placeholder="0"
            disabled={isSaving}
            className="field-input num h-10 bg-field-bg text-[14.5px]"
          />
          {currentPos && currentSharesNum > 0 && (
            <p className="num mt-1 text-[11.5px] text-ink-3">
              Currently {formatQuantity(currentPos.sharesHeld)} sh
            </p>
          )}
        </div>

        <div>
          <label
            htmlFor="edit-holding-avg-cost"
            className="mb-1.5 block text-[13px] font-medium text-ink-2"
          >
            Avg cost / share ({target.currency})
          </label>
          <input
            id="edit-holding-avg-cost"
            type="text"
            inputMode="decimal"
            value={isClearingPosition ? "" : avgCostInput}
            onChange={(event) => setAvgCostInput(event.target.value)}
            placeholder={isClearingPosition ? "Not needed for 0 shares" : "0.00"}
            disabled={isSaving || isClearingPosition}
            className="field-input num h-10 bg-field-bg text-[14.5px] disabled:opacity-50"
          />
          {currentPos?.averageCostPerShare && currentSharesNum > 0 && (
            <p className="num mt-1 text-[11.5px] text-ink-3">
              Currently{" "}
              {formatMoney(currentPos.averageCostPerShare, target.currency)}
            </p>
          )}
        </div>
      </div>

      {/* Optional FX Rate for Non-SGD Holdings */}
      {isNonSgd && !isClearingPosition && (
        <div>
          <label
            htmlFor="edit-holding-fx"
            className="mb-1.5 block text-[13px] font-medium text-ink-2"
          >
            Cost-basis FX rate ({target.currency} to SGD, optional)
          </label>
          <input
            id="edit-holding-fx"
            type="text"
            inputMode="decimal"
            value={fxRateInput}
            onChange={(event) => setFxRateInput(event.target.value)}
            placeholder={currentUsdToSgdRate ?? "e.g. 1.3200"}
            disabled={isSaving}
            className="field-input num h-10 bg-field-bg text-[14px]"
          />
          <p className="mt-1 text-[11.5px] text-ink-3">
            Used to compute your SGD cost basis. Leave blank to reuse existing
            historical FX.
          </p>
        </div>
      )}

      {/* Live Preview Summary */}
      {isClearingPosition ? (
        <div className="rounded-[12px] border border-loss/30 bg-loss/8 px-3.5 py-3 text-[13px] leading-relaxed text-ink">
          <p className="font-medium text-loss">
            Remove open position in {activePortfolio?.name ?? "this portfolio"}
          </p>
          <p className="mt-1 text-[12.5px] text-ink-2">
            Setting shares to 0 clears your open lots for{" "}
            <span className="font-mono font-medium text-ink">
              {formatSymbolForDisplay(target.symbol)}
            </span>{" "}
            here. Historical closed trades and dividends remain intact.
          </p>
        </div>
      ) : (
        <div className="space-y-2 rounded-[12px] border border-line bg-surface-2/60 px-3.5 py-3 text-[13px]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-ink-2">Resulting shares</span>
            <span className="num font-medium text-ink">
              {sharesValid ? formatQuantity(parsedShares) : "—"}
              {sharesDelta !== null && Math.abs(sharesDelta) > 1e-9 && (
                <span
                  className={`ml-1.5 text-[12px] ${
                    sharesDelta > 0 ? "text-gain" : "text-loss"
                  }`}
                >
                  ({sharesDelta > 0 ? "+" : ""}
                  {formatQuantity(sharesDelta)})
                </span>
              )}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-ink-2">Open cost basis</span>
            <span className="num font-semibold text-ink">
              {sharesValid && avgCostValid
                ? formatMoney(previewOpenCost, target.currency)
                : "—"}
            </span>
          </div>
          {previewOpenCostSgd !== null && sharesValid && avgCostValid && (
            <div className="flex items-center justify-between gap-2 text-[12px] text-ink-2">
              <span>Estimated SGD cost basis</span>
              <span className="num">
                {formatMoney(previewOpenCostSgd, "SGD")}
              </span>
            </div>
          )}
        </div>
      )}

      <p className="text-[12px] leading-relaxed text-ink-3">
        Reconciles open FIFO lots in{" "}
        {activePortfolio?.name ?? "this portfolio"} to match your target shares
        and average cost while preserving past closed trades and realized P&amp;L.
      </p>

      {error && (
        <p
          role="alert"
          className="flex items-center gap-1.5 rounded-[10px] bg-loss/10 px-3 py-2 text-[13px] text-loss"
        >
          <AlertCircle size={14} className="shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}

      <div className="grid grid-cols-2 gap-2.5 pt-1 sm:flex sm:justify-end">
        <Button
          type="button"
          variant="secondary"
          onClick={onClose}
          disabled={isSaving}
          className="w-full sm:w-auto"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant={isClearingPosition ? "danger" : "primary"}
          disabled={isSaving || !portfolioId || !sharesValid || !avgCostValid || !fxValid}
          className="w-full sm:w-auto"
        >
          {isSaving ? (
            <>
              <Loader2 size={15} className="animate-spin" aria-hidden="true" />
              <span>Saving...</span>
            </>
          ) : isClearingPosition ? (
            <span>Clear position</span>
          ) : (
            <span>Save holding</span>
          )}
        </Button>
      </div>
    </form>
  );
}
