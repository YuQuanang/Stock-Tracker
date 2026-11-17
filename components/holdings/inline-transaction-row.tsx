"use client";

import {
  AlertCircle,
  Check,
  ChevronDown,
  Loader2,
  Pencil,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Portfolio } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { formatMoney, formatQuantity } from "@/lib/format";
import type { EnrichedTransactionRow } from "@/lib/services/ledger";
import {
  fetchStockPriceClient,
  fetchUsdToSgdClient,
  isAbortError,
} from "@/lib/transactions/client-market-api";
import {
  applyManualFxRateEdit,
  applyManualPriceEdit,
  computeTransactionSgdTotal,
  createLinkedStockStateFromExisting,
  getCurrentSingaporeDateTime,
  type LinkedStockFormState,
} from "@/lib/transactions/form-logic";

type TxType = "Buy" | "Sell" | "Sell All" | "Dividend";

const TX_TYPE_OPTIONS: { value: TxType; label: string }[] = [
  { value: "Buy", label: "Buy" },
  { value: "Sell", label: "Sell" },
  { value: "Sell All", label: "Sell All" },
  { value: "Dividend", label: "Dividend" },
];

interface InlineTransactionRowProps {
  tx: EnrichedTransactionRow;
  instrumentSymbol: string;
  holdingsPortfolios: Portfolio[];
  openSharesTotal?: string | null;
  isEditing: boolean;
  isConfirmingDelete: boolean;
  isDeleting: boolean;
  justSaved: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaved: (txId: string) => void;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}

export function InlineTransactionRow({
  tx,
  instrumentSymbol,
  holdingsPortfolios,
  openSharesTotal = null,
  isEditing,
  isConfirmingDelete,
  isDeleting,
  justSaved,
  onStartEdit,
  onCancelEdit,
  onSaved,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: InlineTransactionRowProps) {
  if (isEditing) {
    return (
      <div className="px-4 py-4 sm:px-5">
        <InlineTransactionEditor
          key={`${tx.id}-${tx.executedAt}-${tx.quantity}-${tx.price}-${tx.portfolioId}`}
          tx={tx}
          instrumentSymbol={instrumentSymbol}
          holdingsPortfolios={holdingsPortfolios}
          openSharesTotal={openSharesTotal}
          onCancel={onCancelEdit}
          onSaved={() => onSaved(tx.id)}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded-[6px] px-2 py-0.5 text-[11.5px] font-medium ${
              tx.type === "Buy"
                ? "bg-accent/12 text-accent"
                : "border border-line bg-surface-2 text-ink-2"
            }`}
          >
            {tx.type}
          </span>
          <span className="font-mono text-[13px] font-medium text-ink">
            {tx.localDate}
          </span>
          <span className="font-mono text-[12px] text-ink-3">
            {tx.localTime}
          </span>
          <span className="text-[12.5px] text-ink-2">
            · {tx.portfolioName}
          </span>
          {justSaved && (
            <span className="inline-flex items-center gap-1 rounded-[6px] bg-gain/12 px-2 py-0.5 text-[11.5px] font-medium text-gain">
              <Check size={12} aria-hidden="true" />
              Saved
            </span>
          )}
        </div>

        <p className="num mt-1 text-[13.5px] text-ink-2">
          {tx.type === "Dividend"
            ? (() => {
                const gross = Number(tx.quantity);
                const commVal = Number(tx.commissionValue ?? 0);
                const taxAmt = tx.commissionIsPercent
                  ? (gross * commVal) / 100
                  : commVal;
                const net = Math.max(0, gross - taxAmt);
                return taxAmt > 0
                  ? `Net dividend ${formatMoney(net, tx.currency)} (Gross ${formatMoney(gross, tx.currency)} · ${tx.commissionRaw} tax)`
                  : `Cash dividend ${formatMoney(tx.quantity, tx.currency)}`;
              })()
            : tx.type === "Sell All"
              ? `All open shares @ ${formatMoney(tx.price, tx.currency)}`
              : `${formatQuantity(tx.quantity)} sh @ ${formatMoney(tx.price, tx.currency)}`}
          {tx.type !== "Dividend" &&
          tx.commissionRaw &&
          tx.commissionRaw !== "0"
            ? ` · Fee ${tx.commissionRaw}`
            : ""}
          {tx.totalCostSgd
            ? ` · ${formatMoney(tx.totalCostSgd, "SGD")} ${tx.type === "Dividend" ? "net SGD" : "total"}`
            : ""}
        </p>

        {tx.type === "Sell All" && (
          <p className="mt-0.5 text-[12px] text-ink-2">
            Closes {instrumentSymbol} in every portfolio that holds it.
          </p>
        )}

        {tx.notes && (
          <p className="mt-0.5 text-[12px] text-ink-3">{tx.notes}</p>
        )}
      </div>

      <div className="flex items-center gap-1.5 self-end sm:self-center">
        {isConfirmingDelete ? (
          <>
            <Button
              variant="danger"
              size="sm"
              onClick={onConfirmDelete}
              disabled={isDeleting}
              className="h-8! px-3! text-[12.5px]!"
            >
              {isDeleting ? "Deleting…" : "Confirm delete"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={onCancelDelete}
              disabled={isDeleting}
              className="h-8! px-2.5! text-[12.5px]!"
            >
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={onStartEdit}
              aria-label={`Edit ${tx.type} transaction on ${tx.localDate}`}
              className="h-8! px-2.5! text-[12.5px]!"
            >
              <Pencil size={13} strokeWidth={1.9} aria-hidden="true" />
              <span>Edit</span>
            </Button>
            <button
              type="button"
              onClick={onRequestDelete}
              aria-label={`Delete ${tx.type} transaction on ${tx.localDate}`}
              className="flex h-8 w-8 items-center justify-center rounded-[10px] text-ink-2 transition-colors hover:bg-loss/12 hover:text-loss"
            >
              <Trash2 size={16} aria-hidden="true" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function InlineTransactionEditor({
  tx,
  instrumentSymbol,
  holdingsPortfolios,
  openSharesTotal,
  onCancel,
  onSaved,
}: {
  tx: EnrichedTransactionRow;
  instrumentSymbol: string;
  holdingsPortfolios: Portfolio[];
  openSharesTotal: string | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [stock, setStock] = useState<LinkedStockFormState>(() =>
    createLinkedStockStateFromExisting(tx),
  );
  const [type, setType] = useState<TxType>(tx.type);
  const [portfolioId, setPortfolioId] = useState<string>(tx.portfolioId);
  const [quantity, setQuantity] = useState<string>(() =>
    tx.type === "Sell All" ? "" : tx.quantity,
  );
  const [commission, setCommission] = useState<string>(
    tx.commissionRaw ?? "0",
  );
  const [date, setDate] = useState<string>(tx.localDate);
  const [time, setTime] = useState<string>(tx.localTime);
  const [notes, setNotes] = useState<string>(tx.notes ?? "");

  const [isLoadingPrice, setIsLoadingPrice] = useState(false);
  const [isLoadingFx, setIsLoadingFx] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const fetchAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      fetchAbortRef.current?.abort();
    };
  }, []);

  const portfolioOptions = useMemo(() => {
    if (holdingsPortfolios.some((p) => p.id === tx.portfolioId)) {
      return holdingsPortfolios;
    }
    return [
      ...holdingsPortfolios,
      {
        id: tx.portfolioId,
        name: tx.portfolioName,
        type: "holdings" as const,
        defaultCurrency: tx.currency,
        sortOrder: 999,
        createdByImportId: null,
        createdAt: new Date(),
      },
    ];
  }, [holdingsPortfolios, tx.portfolioId, tx.portfolioName, tx.currency]);

  const previewTotals = useMemo(
    () =>
      computeTransactionSgdTotal({
        type,
        quantity,
        price: stock.price,
        fxRateToSgd: stock.fxRateToSgd,
        openShares: openSharesTotal,
      }),
    [type, quantity, stock.price, stock.fxRateToSgd, openSharesTotal],
  );

  async function handleFetchQuote(): Promise<void> {
    if (!date || date.length < 10) {
      setSubmitError("Enter a valid date before fetching a historical quote.");
      return;
    }
    fetchAbortRef.current?.abort();
    const controller = new AbortController();
    fetchAbortRef.current = controller;

    setIsLoadingPrice(true);
    setSubmitError(null);
    try {
      const todaySgt = getCurrentSingaporeDateTime().date;
      const quote = await fetchStockPriceClient(
        instrumentSymbol,
        date,
        todaySgt,
        { signal: controller.signal },
      );
      setStock((prev) => ({
        ...prev,
        price: quote.price,
        priceAsOf: quote.asOf,
        priceStatus: quote.priceStatus,
        priceFreshnessLabel: quote.freshnessLabel,
        isManualPrice: false,
        priceError: null,
      }));
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      setStock((prev) => ({
        ...prev,
        priceError:
          error instanceof Error ? error.message : "Could not fetch quote.",
      }));
    } finally {
      setIsLoadingPrice(false);
    }
  }

  async function handleFetchFx(): Promise<void> {
    if (stock.currency === "SGD") {
      return;
    }
    if (!date || date.length < 10) {
      setSubmitError("Enter a valid date before fetching an FX rate.");
      return;
    }
    fetchAbortRef.current?.abort();
    const controller = new AbortController();
    fetchAbortRef.current = controller;

    setIsLoadingFx(true);
    setSubmitError(null);
    try {
      const todaySgt = getCurrentSingaporeDateTime().date;
      const fx = await fetchUsdToSgdClient(date, todaySgt, {
        signal: controller.signal,
      });
      setStock((prev) => ({
        ...prev,
        fxRateToSgd: fx.rate,
        fxAsOf: fx.asOf,
        fxSource: fx.source,
        fxLabel: fx.label,
        isManualFxRate: false,
        fxError: null,
      }));
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      setStock((prev) => ({
        ...prev,
        fxError:
          error instanceof Error ? error.message : "Could not fetch FX rate.",
      }));
    } finally {
      setIsLoadingFx(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitError(null);

    const effectivePrice =
      type === "Dividend" && stock.price.trim() === ""
        ? "0"
        : stock.price.trim();

    if (type !== "Sell All" && !quantity.trim()) {
      setSubmitError(
        type === "Dividend"
          ? "Enter a cash dividend amount."
          : "Enter a share quantity.",
      );
      return;
    }

    if (!effectivePrice) {
      setSubmitError("Enter a price per share before saving.");
      return;
    }

    if (!date || date.length < 10) {
      setSubmitError("Enter a valid transaction date.");
      return;
    }

    setIsSaving(true);
    try {
      const trimmedFx = stock.fxRateToSgd.trim();
      const effectiveFxForPurchase =
        stock.currency === "USD" && trimmedFx !== "" ? trimmedFx : null;

      const response = await fetch(
        `/api/transactions/${encodeURIComponent(tx.id)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            portfolioId,
            symbol: tx.symbol,
            instrumentName: tx.instrumentName,
            exchangeCode: tx.exchangeCode,
            type,
            quantity: type === "Sell All" ? "0" : quantity.trim(),
            price: effectivePrice,
            commission: commission.trim() || "0",
            currency: stock.currency,
            date,
            time: time.trim() || "00:00:00",
            offset: tx.originalOffset || "+0800",
            purchaseFxRate: effectiveFxForPurchase,
            purchaseFxCurrencies: effectiveFxForPurchase ? "USD/SGD" : null,
            priceAsOf: stock.priceAsOf,
            priceStatus: stock.priceStatus,
            fxRateToSgd: stock.currency === "SGD" ? "1" : trimmedFx || null,
            fxAsOf: stock.fxAsOf,
            fxSource: stock.fxSource,
            isManualPrice: stock.isManualPrice,
            isManualFxRate: stock.isManualFxRate,
            notes: notes.trim() || null,
          }),
        },
      );

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setSubmitError(
          body?.error ?? "Could not update transaction. Check your inputs.",
        );
        return;
      }

      onSaved();
    } catch {
      setSubmitError("Network error while updating transaction.");
    } finally {
      setIsSaving(false);
    }
  }

  const quantityLabel =
    type === "Dividend" ? `Cash dividend (${stock.currency})` : "Shares";
  const priceLabel =
    type === "Dividend"
      ? `Share price snapshot (${stock.currency})`
      : `Price (${stock.currency})`;

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !isSaving) {
          event.preventDefault();
          onCancel();
        }
      }}
      aria-label={`Edit ${tx.type} transaction on ${tx.localDate}`}
      className="space-y-3.5 rounded-[12px] border border-line bg-surface-2/60 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-ink">
            Edit transaction
          </span>
          <span className="font-mono text-[12px] text-ink-3">
            {instrumentSymbol} · {stock.currency}
          </span>
        </div>
        <button
          type="button"
          onClick={onCancel}
          disabled={isSaving}
          className="text-[12.5px] font-medium text-ink-2 transition-colors hover:text-ink"
        >
          Cancel
        </button>
      </div>

      {/* Row 1: Type, Portfolio, Date, Time */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label
            htmlFor={`inline-tx-type-${tx.id}`}
            className="mb-1 block text-[12px] font-medium text-ink-2"
          >
            Type
          </label>
          <div className="relative">
            <select
              id={`inline-tx-type-${tx.id}`}
              value={type}
              onChange={(event) => setType(event.target.value as TxType)}
              className="field-input h-9.5 appearance-none bg-field-bg pr-8 text-[13.5px]"
              disabled={isSaving}
            >
              {TX_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <ChevronDown
              size={15}
              aria-hidden="true"
              className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-2"
            />
          </div>
        </div>

        <div>
          <label
            htmlFor={`inline-tx-portfolio-${tx.id}`}
            className="mb-1 block text-[12px] font-medium text-ink-2"
          >
            Portfolio
          </label>
          <div className="relative">
            <select
              id={`inline-tx-portfolio-${tx.id}`}
              value={portfolioId}
              onChange={(event) => setPortfolioId(event.target.value)}
              className="field-input h-9.5 appearance-none bg-field-bg pr-8 text-[13.5px]"
              disabled={isSaving}
            >
              {portfolioOptions.map((pf) => (
                <option key={pf.id} value={pf.id}>
                  {pf.name}
                </option>
              ))}
            </select>
            <ChevronDown
              size={15}
              aria-hidden="true"
              className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-2"
            />
          </div>
        </div>

        <div>
          <label
            htmlFor={`inline-tx-date-${tx.id}`}
            className="mb-1 block text-[12px] font-medium text-ink-2"
          >
            Date (SGT)
          </label>
          <input
            id={`inline-tx-date-${tx.id}`}
            type="date"
            required
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className="field-input num h-9.5 bg-field-bg text-[13.5px]"
            disabled={isSaving}
          />
        </div>

        <div>
          <label
            htmlFor={`inline-tx-time-${tx.id}`}
            className="mb-1 block text-[12px] font-medium text-ink-2"
          >
            Time (SGT)
          </label>
          <input
            id={`inline-tx-time-${tx.id}`}
            type="time"
            step={1}
            value={time}
            onChange={(event) => setTime(event.target.value)}
            className="field-input num h-9.5 bg-field-bg text-[13.5px]"
            disabled={isSaving}
          />
        </div>
      </div>

      {/* Row 2: Quantity, Price, FX Rate, Commission */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label
            htmlFor={`inline-tx-qty-${tx.id}`}
            className="mb-1 block truncate text-[12px] font-medium text-ink-2"
          >
            {quantityLabel}
          </label>
          <input
            id={`inline-tx-qty-${tx.id}`}
            type="text"
            inputMode="decimal"
            required={type !== "Sell All"}
            disabled={isSaving || type === "Sell All"}
            value={type === "Sell All" ? "All open" : quantity}
            onChange={(event) => setQuantity(event.target.value)}
            placeholder={type === "Dividend" ? "1.22" : "10"}
            className="field-input num h-9.5 bg-field-bg text-[13.5px]"
          />
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <label
              htmlFor={`inline-tx-price-${tx.id}`}
              className="truncate text-[12px] font-medium text-ink-2"
            >
              {priceLabel}
            </label>
            <button
              type="button"
              onClick={() => void handleFetchQuote()}
              disabled={isLoadingPrice || isSaving}
              className="text-[11px] font-medium text-accent transition-colors hover:underline disabled:opacity-50"
            >
              {isLoadingPrice ? "Fetching…" : "Fetch"}
            </button>
          </div>
          <input
            id={`inline-tx-price-${tx.id}`}
            type="text"
            inputMode="decimal"
            required={type !== "Dividend"}
            value={stock.price}
            onChange={(event) =>
              setStock((prev) =>
                applyManualPriceEdit(prev, event.target.value),
              )
            }
            placeholder="0.00"
            className="field-input num h-9.5 bg-field-bg text-[13.5px]"
            disabled={isSaving}
          />
          {stock.priceError && (
            <p role="alert" className="mt-1 text-[11px] text-loss">
              {stock.priceError}
            </p>
          )}
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <label
              htmlFor={`inline-tx-fx-${tx.id}`}
              className="truncate text-[12px] font-medium text-ink-2"
            >
              USD → SGD rate
            </label>
            {stock.currency === "USD" && (
              <button
                type="button"
                onClick={() => void handleFetchFx()}
                disabled={isLoadingFx || isSaving}
                className="text-[11px] font-medium text-accent transition-colors hover:underline disabled:opacity-50"
              >
                {isLoadingFx ? "Fetching…" : "Fetch"}
              </button>
            )}
          </div>
          {stock.currency === "SGD" ? (
            <input
              id={`inline-tx-fx-${tx.id}`}
              type="text"
              readOnly
              disabled
              value="1.0000 (SGD)"
              className="field-input num h-9.5 bg-field-bg text-[13.5px] text-ink-2"
            />
          ) : (
            <input
              id={`inline-tx-fx-${tx.id}`}
              type="text"
              inputMode="decimal"
              value={stock.fxRateToSgd}
              onChange={(event) =>
                setStock((prev) =>
                  applyManualFxRateEdit(prev, event.target.value),
                )
              }
              placeholder="1.3200"
              className="field-input num h-9.5 bg-field-bg text-[13.5px]"
              disabled={isSaving}
            />
          )}
          {stock.fxError && (
            <p role="alert" className="mt-1 text-[11px] text-loss">
              {stock.fxError}
            </p>
          )}
        </div>

        <div>
          <label
            htmlFor={`inline-tx-commission-${tx.id}`}
            className="mb-1 block truncate text-[12px] font-medium text-ink-2"
          >
            Commission
          </label>
          <input
            id={`inline-tx-commission-${tx.id}`}
            type="text"
            value={commission}
            onChange={(event) => setCommission(event.target.value)}
            placeholder="0 or 1%"
            className="field-input num h-9.5 bg-field-bg text-[13.5px]"
            disabled={isSaving}
          />
        </div>
      </div>

      {/* Row 3: Notes */}
      <div>
        <label
          htmlFor={`inline-tx-notes-${tx.id}`}
          className="mb-1 block text-[12px] font-medium text-ink-2"
        >
          Notes
        </label>
        <input
          id={`inline-tx-notes-${tx.id}`}
          type="text"
          maxLength={1000}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Optional trade rationale or broker note"
          className="field-input h-9.5 bg-field-bg text-[13.5px]"
          disabled={isSaving}
        />
      </div>

      {submitError && (
        <p
          role="alert"
          className="flex items-center gap-1.5 rounded-[10px] bg-loss/10 px-3 py-2 text-[12.5px] text-loss"
        >
          <AlertCircle size={14} className="shrink-0" aria-hidden="true" />
          <span>{submitError}</span>
        </p>
      )}

      <div className="flex flex-col gap-2.5 border-t border-line pt-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="num text-[12.5px] text-ink-2">
          {previewTotals ? (
            <>
              <span>
                Gross {formatMoney(previewTotals.nativeGross, stock.currency)}
              </span>
              <span className="mx-1.5 text-ink-3">·</span>
              <span className="font-medium text-ink">
                {formatMoney(previewTotals.totalSgd, "SGD")} SGD total
              </span>
            </>
          ) : (
            <span>
              {type === "Sell All"
                ? "Closes open lots chronologically"
                : "Enter quantity, price, and FX to preview SGD total"}
            </span>
          )}
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onCancel}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={isSaving}>
            {isSaving ? (
              <>
                <Loader2
                  size={14}
                  className="animate-spin"
                  aria-hidden="true"
                />
                <span>Saving…</span>
              </>
            ) : (
              <span>Save changes</span>
            )}
          </Button>
        </div>
      </div>
    </form>
  );
}

