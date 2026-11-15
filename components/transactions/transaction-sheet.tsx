"use client";

import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { Portfolio } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet } from "@/components/ui/sheet";
import { toDecimal } from "@/lib/finance/decimal";
import { formatMoney, formatQuantity } from "@/lib/format";
import type { SymbolSearchMatch } from "@/lib/market-data/search";
import type {
  EnrichedTransactionRow,
  LedgerPositionSummary,
} from "@/lib/services/ledger";
import {
  ClientMarketError,
  fetchStockPriceClient,
  fetchUsdToSgdClient,
  isAbortError,
  lookupExactSymbolClient,
  searchStocksClient,
} from "@/lib/transactions/client-market-api";
import {
  applyCompanyNameInputEdit,
  applyManualFxRateEdit,
  applyManualPriceEdit,
  applyStockSelection,
  applySymbolInputEdit,
  clearAutoFilledForDateChange,
  computeTransactionSgdTotal,
  createInitialLinkedStockState,
  createLinkedStockStateFromExisting,
  formatExchangeCodeForDisplay,
  getCurrentSingaporeDateTime,
  type LinkedStockFormState,
} from "@/lib/transactions/form-logic";

type TxType = "Buy" | "Sell" | "Sell All" | "Dividend";
type ActiveSearchField = "symbol" | "name" | null;

const TX_TYPE_OPTIONS: { value: TxType; label: string }[] = [
  { value: "Buy", label: "Buy" },
  { value: "Sell", label: "Sell" },
  { value: "Sell All", label: "Sell All" },
  { value: "Dividend", label: "Dividend" },
];

const SEARCH_DEBOUNCE_MS = 300;

interface DropdownStatus {
  isLoading: boolean;
  matches: SymbolSearchMatch[];
  errorKind: "rate_limit" | "network" | "upstream" | null;
  errorMessage: string | null;
  searchedQuery: string;
}

const INITIAL_DROPDOWN_STATUS: DropdownStatus = {
  isLoading: false,
  matches: [],
  errorKind: null,
  errorMessage: null,
  searchedQuery: "",
};

export interface DefaultTransactionStock {
  symbol: string;
  name: string | null;
  exchangeCode: string | null;
  currency: "USD" | "SGD";
}

interface TransactionSheetProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
  portfolios: Portfolio[];
  positions?: LedgerPositionSummary[];
  /** When non-null, edits an existing transaction instead of creating one. */
  editingTransaction?: EnrichedTransactionRow | null;
  defaultPortfolioId?: string;
  /** Optional stock pre-selection (e.g. from Stock Detail or Watchlist). */
  defaultStock?: DefaultTransactionStock | null;
  /** Optional initial quantity when converting a simulated position to Buy. */
  defaultQuantity?: string;
}

export function TransactionSheet({
  isOpen,
  onClose,
  onSaved,
  portfolios,
  positions = [],
  editingTransaction = null,
  defaultPortfolioId,
  defaultStock = null,
  defaultQuantity,
}: TransactionSheetProps) {
  const holdingsPortfolios = portfolios.filter((p) => p.type === "holdings");

  const nowSgtOnOpen = useMemo(() => getCurrentSingaporeDateTime(), []);

  const initialPortfolioId =
    editingTransaction?.portfolioId ??
    defaultPortfolioId ??
    holdingsPortfolios[0]?.id ??
    "";

  const [portfolioId, setPortfolioId] = useState(initialPortfolioId);
  const [type, setType] = useState<TxType>(editingTransaction?.type ?? "Buy");

  const [stock, setStock] = useState<LinkedStockFormState>(() => {
    if (editingTransaction) {
      return createLinkedStockStateFromExisting(editingTransaction);
    }
    if (defaultStock) {
      return applyStockSelection(createInitialLinkedStockState(), {
        symbol: defaultStock.symbol,
        name: defaultStock.name ?? defaultStock.symbol,
        exchangeCode: defaultStock.exchangeCode ?? "",
        exchangeDisplay: formatExchangeCodeForDisplay(
          defaultStock.exchangeCode,
        ),
        currency: defaultStock.currency,
        quoteType: "EQUITY",
      });
    }
    return createInitialLinkedStockState();
  });

  // Mirror latest stock state in a ref so async callbacks (blur, parallel
  // fetches) can read the freshest state without stale closures.
  const stockRef = useRef<LinkedStockFormState>(stock);
  useEffect(() => {
    stockRef.current = stock;
  }, [stock]);

  function commitStockState(
    updater:
      | LinkedStockFormState
      | ((prev: LinkedStockFormState) => LinkedStockFormState),
  ): LinkedStockFormState {
    const nextState =
      typeof updater === "function" ? updater(stockRef.current) : updater;
    stockRef.current = nextState;
    setStock(nextState);
    return nextState;
  }

  const [quantity, setQuantity] = useState(() => {
    if (!editingTransaction) {
      return defaultQuantity ?? "";
    }
    if (editingTransaction.type === "Sell All") {
      return "0";
    }
    return editingTransaction.quantity;
  });

  const [commission, setCommission] = useState(
    editingTransaction?.commissionRaw ?? "0",
  );
  const [date, setDate] = useState(
    editingTransaction?.localDate ?? nowSgtOnOpen.date,
  );
  const [time, setTime] = useState(
    editingTransaction?.localTime ?? nowSgtOnOpen.time,
  );
  const [notes, setNotes] = useState(editingTransaction?.notes ?? "");

  // Autocomplete dropdown state
  const [activeField, setActiveField] = useState<ActiveSearchField>(null);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(0);
  const [dropdown, setDropdown] = useState<DropdownStatus>(
    INITIAL_DROPDOWN_STATUS,
  );
  const [isVerifyingExactSymbol, setIsVerifyingExactSymbol] = useState(false);

  // Field-scoped loading spinners for parallel quote + FX requests
  const [isLoadingPrice, setIsLoadingPrice] = useState(false);
  const [isLoadingFx, setIsLoadingFx] = useState(false);

  // Warning banner when backdating while manual price/FX overrides are present
  const [manualBackdateWarningDate, setManualBackdateWarningDate] = useState<
    string | null
  >(null);

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Timers, request counters, and abort controllers
  const searchTimerRef = useRef<number | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchRequestIdRef = useRef<number>(0);

  const marketAbortRef = useRef<AbortController | null>(null);
  const marketRequestIdRef = useRef<number>(0);

  useEffect(() => {
    return () => {
      if (searchTimerRef.current !== null) {
        window.clearTimeout(searchTimerRef.current);
      }
      searchAbortRef.current?.abort();
      marketAbortRef.current?.abort();
    };
  }, []);

  function cancelPendingSearch(): void {
    if (searchTimerRef.current !== null) {
      window.clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    searchRequestIdRef.current += 1;
  }

  function closeDropdown(): void {
    cancelPendingSearch();
    setActiveField(null);
    setDropdown(INITIAL_DROPDOWN_STATUS);
    setHighlightedIndex(0);
  }

  function scheduleLiveSearch(
    field: "symbol" | "name",
    rawQuery: string,
  ): void {
    cancelPendingSearch();

    const trimmed = rawQuery.trim();
    const minChars = field === "symbol" ? 1 : 2;
    if (trimmed.length < minChars) {
      setActiveField(null);
      setDropdown(INITIAL_DROPDOWN_STATUS);
      return;
    }

    setActiveField(field);
    setHighlightedIndex(0);
    setDropdown({
      isLoading: true,
      matches: [],
      errorKind: null,
      errorMessage: null,
      searchedQuery: trimmed,
    });

    const requestId = searchRequestIdRef.current + 1;
    searchRequestIdRef.current = requestId;

    searchTimerRef.current = window.setTimeout(async () => {
      const controller = new AbortController();
      searchAbortRef.current = controller;

      try {
        const matches = await searchStocksClient(trimmed, {
          signal: controller.signal,
        });
        if (searchRequestIdRef.current !== requestId) {
          return;
        }
        setDropdown({
          isLoading: false,
          matches,
          errorKind: null,
          errorMessage: null,
          searchedQuery: trimmed,
        });
        setHighlightedIndex(0);
      } catch (error) {
        if (isAbortError(error) || searchRequestIdRef.current !== requestId) {
          return;
        }
        const kind =
          error instanceof ClientMarketError && error.kind !== "not_found"
            ? error.kind
            : "upstream";
        const message =
          error instanceof Error
            ? error.message
            : "Could not search stocks right now.";

        setDropdown({
          isLoading: false,
          matches: [],
          errorKind: kind,
          errorMessage: message,
          searchedQuery: trimmed,
        });
      }
    }, SEARCH_DEBOUNCE_MS);
  }

  /**
   * Fetches latest (or historical backdated) stock price and USD->SGD exchange
   * rate concurrently in parallel, showing loading indicators ONLY on the Price
   * and FX fields.
   */
  function triggerParallelPriceAndFxFetch(params: {
    symbol: string;
    currency: "USD" | "SGD";
    targetDate: string;
    skipPrice?: boolean;
    skipFx?: boolean;
  }): void {
    marketAbortRef.current?.abort();
    const controller = new AbortController();
    marketAbortRef.current = controller;

    const requestId = marketRequestIdRef.current + 1;
    marketRequestIdRef.current = requestId;

    const todaySgt = getCurrentSingaporeDateTime().date;
    const shouldFetchPrice = !params.skipPrice;
    const shouldFetchFx = params.currency === "USD" && !params.skipFx;

    setIsLoadingPrice(shouldFetchPrice);
    setIsLoadingFx(shouldFetchFx);

    if (shouldFetchPrice) {
      void fetchStockPriceClient(params.symbol, params.targetDate, todaySgt, {
        signal: controller.signal,
      })
        .then((quote) => {
          if (marketRequestIdRef.current !== requestId) {
            return;
          }
          commitStockState((prev) => {
            if (prev.isManualPrice) {
              return prev;
            }
            return {
              ...prev,
              price: quote.price,
              priceAsOf: quote.asOf,
              priceStatus: quote.priceStatus,
              priceFreshnessLabel: quote.freshnessLabel,
              isManualPrice: false,
              priceError: null,
            };
          });
        })
        .catch((error: unknown) => {
          if (isAbortError(error) || marketRequestIdRef.current !== requestId) {
            return;
          }
          const message =
            error instanceof Error
              ? error.message
              : "Could not load price. Enter it manually.";
          commitStockState((prev) => {
            if (prev.isManualPrice) {
              return prev;
            }
            return {
              ...prev,
              price: "",
              priceAsOf: null,
              priceStatus: null,
              priceFreshnessLabel: null,
              priceError: message,
            };
          });
        })
        .finally(() => {
          if (marketRequestIdRef.current === requestId) {
            setIsLoadingPrice(false);
          }
        });
    }

    if (shouldFetchFx) {
      void fetchUsdToSgdClient(params.targetDate, todaySgt, {
        signal: controller.signal,
      })
        .then((fx) => {
          if (marketRequestIdRef.current !== requestId) {
            return;
          }
          commitStockState((prev) => {
            if (prev.isManualFxRate) {
              return prev;
            }
            return {
              ...prev,
              fxRateToSgd: fx.rate,
              fxAsOf: fx.asOf,
              fxSource: fx.source,
              fxLabel: fx.label,
              isManualFxRate: false,
              fxError: null,
            };
          });
        })
        .catch((error: unknown) => {
          if (isAbortError(error) || marketRequestIdRef.current !== requestId) {
            return;
          }
          const message =
            error instanceof Error
              ? error.message
              : "Could not load USD/SGD rate. Enter it manually.";
          commitStockState((prev) => {
            if (prev.isManualFxRate) {
              return prev;
            }
            return {
              ...prev,
              fxRateToSgd: "",
              fxAsOf: null,
              fxSource: null,
              fxLabel: null,
              fxError: message,
            };
          });
        })
        .finally(() => {
          if (marketRequestIdRef.current === requestId) {
            setIsLoadingFx(false);
          }
        });
    }
  }

  // Auto-fetch price + FX when opened with a pre-selected `defaultStock`
  useEffect(() => {
    if (!isOpen || editingTransaction || !defaultStock) {
      return;
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) {
        return;
      }
      triggerParallelPriceAndFxFetch({
        symbol: defaultStock.symbol,
        currency: defaultStock.currency,
        targetDate: date,
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  function handleSelectMatch(match: SymbolSearchMatch): void {
    closeDropdown();
    setManualBackdateWarningDate(null);
    setSubmitError(null);

    commitStockState((prev) => applyStockSelection(prev, match));

    triggerParallelPriceAndFxFetch({
      symbol: match.symbol,
      currency: match.currency,
      targetDate: date,
    });
  }

  function handleSymbolInputChange(nextValue: string): void {
    marketAbortRef.current?.abort();
    marketRequestIdRef.current += 1;
    setIsLoadingPrice(false);
    setIsLoadingFx(false);
    setManualBackdateWarningDate(null);

    commitStockState((prev) => applySymbolInputEdit(prev, nextValue));
    scheduleLiveSearch("symbol", nextValue);
  }

  function handleCompanyNameInputChange(nextValue: string): void {
    marketAbortRef.current?.abort();
    marketRequestIdRef.current += 1;
    setIsLoadingPrice(false);
    setIsLoadingFx(false);
    setManualBackdateWarningDate(null);

    commitStockState((prev) => applyCompanyNameInputEdit(prev, nextValue));
    scheduleLiveSearch("name", nextValue);
  }

  /**
   * Rule 10: If the user types a full symbol and leaves the Symbol field
   * without picking from the dropdown, verify that exact symbol and populate
   * its official company name (or show a validation error if none exists).
   */
  async function verifyUnselectedSymbol(
    symbolToVerify: string,
  ): Promise<boolean> {
    const trimmed = symbolToVerify.trim();
    if (!trimmed) {
      return false;
    }

    setIsVerifyingExactSymbol(true);
    try {
      const exactMatch = await lookupExactSymbolClient(trimmed);
      if (
        stockRef.current.symbol.trim().toUpperCase() !==
        trimmed.toUpperCase()
      ) {
        return false;
      }
      handleSelectMatch(exactMatch);
      return true;
    } catch (error) {
      if (
        stockRef.current.symbol.trim().toUpperCase() !==
        trimmed.toUpperCase()
      ) {
        return false;
      }
      const message =
        error instanceof Error
          ? error.message
          : `Could not verify ticker "${trimmed.toUpperCase()}".`;
      commitStockState((prev) => ({
        ...prev,
        symbolValidationError: message,
      }));
      return false;
    } finally {
      setIsVerifyingExactSymbol(false);
    }
  }

  function handleSymbolBlur(): void {
    if (activeField === "symbol") {
      closeDropdown();
    }
    const current = stockRef.current;
    if (
      current.selectionState === "unverified" &&
      current.symbol.trim() !== ""
    ) {
      void verifyUnselectedSymbol(current.symbol);
    }
  }

  function handleCompanyNameBlur(): void {
    if (activeField === "name") {
      closeDropdown();
    }
  }

  function handleDropdownKeyDown(
    event: ReactKeyboardEvent<HTMLInputElement>,
    field: "symbol" | "name",
  ): void {
    if (activeField !== field) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeDropdown();
      return;
    }

    if (dropdown.matches.length === 0) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((prev) =>
        prev + 1 < dropdown.matches.length ? prev + 1 : 0,
      );
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((prev) =>
        prev - 1 >= 0 ? prev - 1 : dropdown.matches.length - 1,
      );
      return;
    }

    if (event.key === "Enter") {
      const chosen = dropdown.matches[highlightedIndex];
      if (chosen) {
        event.preventDefault();
        handleSelectMatch(chosen);
      }
    }
  }

  function handleDateChange(nextDate: string): void {
    setDate(nextDate);

    const current = stockRef.current;
    if (current.selectionState !== "verified" || !current.symbol) {
      return;
    }

    commitStockState((prev) => clearAutoFilledForDateChange(prev, nextDate));

    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) {
      return;
    }

    const hasManualPrice = current.isManualPrice;
    const hasManualUsdFx =
      current.currency === "USD" && current.isManualFxRate;

    if (hasManualPrice || hasManualUsdFx) {
      setManualBackdateWarningDate(nextDate);
    } else {
      setManualBackdateWarningDate(null);
    }

    triggerParallelPriceAndFxFetch({
      symbol: current.symbol,
      currency: current.currency,
      targetDate: nextDate,
      skipPrice: hasManualPrice,
      skipFx: hasManualUsdFx,
    });
  }

  function handleLoadHistoricalReplacingManual(): void {
    const current = stockRef.current;
    if (!current.symbol) {
      return;
    }
    const isSgd = current.currency === "SGD";
    const resetManualState: LinkedStockFormState = {
      ...current,
      price: "",
      priceAsOf: null,
      priceStatus: null,
      priceFreshnessLabel: null,
      isManualPrice: false,
      priceError: null,
      fxRateToSgd: isSgd ? "1" : "",
      fxAsOf: isSgd ? `${date}T00:00:00.000Z` : null,
      fxSource: isSgd ? "native-sgd" : null,
      fxLabel: isSgd ? "Priced in SGD (1:1)" : null,
      isManualFxRate: false,
      fxError: null,
    };
    commitStockState(resetManualState);
    setManualBackdateWarningDate(null);

    triggerParallelPriceAndFxFetch({
      symbol: current.symbol,
      currency: current.currency,
      targetDate: date,
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitError(null);

    let current = stockRef.current;
    if (!current.symbol.trim()) {
      setSubmitError(
        "Choose a stock from the search suggestions or enter a valid ticker.",
      );
      return;
    }

    if (current.symbolValidationError) {
      setSubmitError(current.symbolValidationError);
      return;
    }

    if (current.selectionState !== "verified") {
      const verified = await verifyUnselectedSymbol(current.symbol);
      if (!verified) {
        return;
      }
      current = stockRef.current;
    }

    if (!current.price.trim()) {
      setSubmitError("Enter a price per share before saving.");
      return;
    }

    setIsSubmitting(true);
    try {
      const endpoint = editingTransaction
        ? `/api/transactions/${editingTransaction.id}`
        : "/api/transactions";
      const method = editingTransaction ? "PUT" : "POST";

      const trimmedFx = current.fxRateToSgd.trim();
      const effectiveFxForPurchase =
        current.currency === "USD" && trimmedFx !== "" ? trimmedFx : null;

      const response = await fetch(endpoint, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          portfolioId,
          symbol: current.symbol.trim(),
          instrumentName: current.instrumentName.trim() || null,
          exchangeCode: current.exchangeCode.trim() || null,
          type,
          quantity: type === "Sell All" ? "0" : quantity,
          price: current.price.trim(),
          commission: commission.trim() || "0",
          currency: current.currency,
          date,
          time,
          offset: editingTransaction?.originalOffset ?? "+0800",
          purchaseFxRate: effectiveFxForPurchase,
          purchaseFxCurrencies: effectiveFxForPurchase ? "USD/SGD" : null,
          priceAsOf: current.priceAsOf,
          priceStatus: current.priceStatus,
          fxRateToSgd: current.currency === "SGD" ? "1" : trimmedFx || null,
          fxAsOf: current.fxAsOf,
          fxSource: current.fxSource,
          isManualPrice: current.isManualPrice,
          isManualFxRate: current.isManualFxRate,
          notes: notes.trim() || null,
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setSubmitError(
          body?.error ?? "Could not save transaction. Check your inputs.",
        );
        return;
      }

      onSaved();
      onClose();
    } catch {
      setSubmitError("Could not reach the server. Check your connection.");
    } finally {
      setIsSubmitting(false);
    }
  }

  // `Sell All` closes the symbol in EVERY portfolio, so the preview sums the
  // open shares held across all portfolios.
  const openSharesForSellAll = useMemo(() => {
    if (type !== "Sell All" || !stock.symbol) {
      return null;
    }
    const symbolKey = stock.symbol.trim().toUpperCase();
    let total = toDecimal(0);
    let found = false;
    for (const pos of positions) {
      if (pos.symbol.toUpperCase() !== symbolKey) {
        continue;
      }
      found = true;
      total = total.plus(toDecimal(pos.sharesHeld));
    }
    return found && total.gt(0) ? total.toFixed() : null;
  }, [type, stock.symbol, positions]);

  const sellAllPortfolioCount = useMemo(() => {
    if (type !== "Sell All" || !stock.symbol) {
      return 0;
    }
    const symbolKey = stock.symbol.trim().toUpperCase();
    return positions.filter(
      (pos) =>
        pos.symbol.toUpperCase() === symbolKey && Number(pos.sharesHeld) > 0,
    ).length;
  }, [type, stock.symbol, positions]);

  const sgdPreview = useMemo(
    () =>
      computeTransactionSgdTotal({
        type,
        quantity,
        price: stock.price,
        fxRateToSgd: stock.currency === "SGD" ? "1" : stock.fxRateToSgd,
        openShares: openSharesForSellAll,
      }),
    [
      type,
      quantity,
      stock.price,
      stock.currency,
      stock.fxRateToSgd,
      openSharesForSellAll,
    ],
  );

  // Short, strictly single-line labels keep side-by-side inputs baseline-locked
  // at every mobile and desktop viewport width.
  let quantityLabel = "Shares";
  if (type === "Dividend") {
    quantityLabel = "Cash dividend";
  }

  let priceLabel = "Buy price";
  if (type === "Dividend") {
    priceLabel = "Share price";
  } else if (type === "Sell" || type === "Sell All") {
    priceLabel = "Sale price";
  }

  let sgdSummarySubtitle = "Enter quantity and price to calculate SGD total";
  if (type === "Sell All" && sgdPreview && openSharesForSellAll) {
    sgdSummarySubtitle =
      stock.currency === "USD"
        ? `All ${formatQuantity(openSharesForSellAll)} sh × ${formatMoney(stock.price, "USD")} @ ${stock.fxRateToSgd}`
        : `All ${formatQuantity(openSharesForSellAll)} sh × ${formatMoney(stock.price, "SGD")} (native SGD)`;
  } else if (type === "Sell All") {
    sgdSummarySubtitle = "Closes all remaining open shares in FIFO order";
  } else if (sgdPreview && stock.currency === "USD") {
    const qtyText =
      type === "Dividend"
        ? formatMoney(quantity, "USD")
        : `${formatQuantity(quantity)} × ${formatMoney(stock.price, "USD")}`;
    sgdSummarySubtitle = `${qtyText} @ ${stock.fxRateToSgd}${
      stock.isManualFxRate ? " (manual rate)" : ""
    }`;
  } else if (sgdPreview && stock.currency === "SGD") {
    sgdSummarySubtitle =
      type === "Dividend"
        ? "Native SGD dividend (rate 1:1)"
        : `${formatQuantity(quantity)} × ${formatMoney(stock.price, "SGD")} (native SGD)`;
  } else if (stock.currency === "USD" && stock.fxRateToSgd.trim() !== "") {
    sgdSummarySubtitle = `Snapshot rate ${stock.fxRateToSgd} USD → SGD${
      stock.isManualFxRate ? " (manual)" : ""
    }`;
  }

  function renderSuggestionDropdown(field: "symbol" | "name") {
    if (activeField !== field) {
      return null;
    }

    // Anchor left on Symbol and right on Company name on desktop so wide
    // popovers never overflow either edge of the sheet; full-width on mobile.
    const alignmentClasses =
      field === "symbol"
        ? "left-0 right-0 sm:right-auto sm:w-[360px]"
        : "left-0 right-0 sm:left-auto sm:right-0 sm:w-[360px]";

    return (
      <div
        role="listbox"
        aria-label="Matching stocks and ETFs"
        className={`absolute top-full z-30 mt-1.5 max-h-60 overflow-y-auto rounded-[12px] border border-line bg-surface-2 p-1.5 shadow-raised ${alignmentClasses}`}
      >
        {dropdown.isLoading && (
          <div className="flex items-center gap-2.5 px-3 py-3 text-[13px] text-ink-2">
            <Loader2
              size={15}
              className="animate-spin text-accent"
              aria-hidden="true"
            />
            <span>Searching live listings…</span>
          </div>
        )}

        {!dropdown.isLoading && dropdown.errorMessage !== null && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-[9px] bg-loss/10 px-3 py-2.5 text-[13px] text-loss"
          >
            <AlertCircle
              size={15}
              className="mt-0.5 shrink-0"
              aria-hidden="true"
            />
            <span>{dropdown.errorMessage}</span>
          </div>
        )}

        {!dropdown.isLoading &&
          dropdown.errorMessage === null &&
          dropdown.matches.length === 0 && (
            <div className="px-3 py-3 text-[13px] text-ink-3">
              No US or SGX listings match “{dropdown.searchedQuery}”.
            </div>
          )}

        {!dropdown.isLoading &&
          dropdown.errorMessage === null &&
          dropdown.matches.map((item, idx) => {
            const isHighlighted = idx === highlightedIndex;
            return (
              <button
                key={`${item.symbol}-${item.exchangeCode}`}
                type="button"
                role="option"
                aria-selected={isHighlighted}
                onMouseEnter={() => setHighlightedIndex(idx)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  handleSelectMatch(item);
                }}
                className={`flex w-full items-center justify-between gap-3 rounded-[9px] px-3 py-2 text-left transition-colors ${
                  isHighlighted ? "bg-accent/14 text-ink" : "hover:bg-surface-2"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[14px] font-semibold">
                      {item.symbol}
                    </span>
                    <span className="text-[11px] font-medium text-ink-3">
                      {item.currency}
                    </span>
                  </div>
                  <div className="truncate text-[13px] text-ink-2">
                    {item.name}
                  </div>
                </div>
                <span className="shrink-0 rounded-md border border-line bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-ink-2">
                  {item.exchangeDisplay}
                </span>
              </button>
            );
          })}
      </div>
    );
  }

  return (
    <Sheet
      isOpen={isOpen}
      onClose={onClose}
      maxWidthClass="sm:max-w-[540px]"
      title={editingTransaction ? "Edit Transaction" : "New Transaction"}
      description="Live ticker search, market price, and permanent SGD snapshot."
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Full-width Apple segmented mode switcher */}
        <SegmentedControl
          ariaLabel="Transaction type"
          options={TX_TYPE_OPTIONS}
          value={type}
          onChange={(nextType) => {
            setType(nextType);
            if (nextType === "Sell All") {
              setQuantity("0");
            } else if (quantity === "0") {
              setQuantity("");
            }
          }}
          layoutId="tx-sheet-type"
          fullWidth
        />

        {/* Portfolio selector + inline verified exchange badge */}
        <div>
          <div className="mb-1.5 flex h-5 items-center justify-between gap-2">
            <label
              htmlFor="tx-portfolio"
              className="text-[13px] font-medium text-ink-2"
            >
              Portfolio
            </label>
            {stock.selectionState === "verified" ? (
              <span className="inline-flex items-center gap-1.25 whitespace-nowrap rounded-[6px] bg-accent/12 px-2 py-0.5 text-[11px] font-medium text-accent">
                <CheckCircle2 size={12} aria-hidden="true" />
                {stock.exchangeDisplay || stock.exchangeCode || "Verified"} ·{" "}
                {stock.currency}
              </span>
            ) : isVerifyingExactSymbol ? (
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] text-ink-2">
                <Loader2
                  size={12}
                  className="animate-spin text-accent"
                  aria-hidden="true"
                />
                Verifying…
              </span>
            ) : null}
          </div>

          <div className="relative">
            <select
              id="tx-portfolio"
              required
              value={portfolioId}
              onChange={(event) => setPortfolioId(event.target.value)}
              className="field-input appearance-none pr-9"
            >
              {holdingsPortfolios.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({item.defaultCurrency})
                </option>
              ))}
            </select>
            <ChevronDown
              size={16}
              strokeWidth={2}
              aria-hidden="true"
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-3"
            />
          </div>
        </div>

        {/* Two-way linked Symbol & Company name (stacked on mobile for full-width
            autocomplete popover; 5/7 split on desktop with locked baselines) */}
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-12 sm:gap-3">
          <div className="relative sm:col-span-5">
            <label
              htmlFor="tx-symbol"
              className="mb-1.5 block h-5 truncate text-[13px] font-medium leading-5 text-ink-2"
            >
              Symbol
            </label>
            <input
              id="tx-symbol"
              type="text"
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="AAPL or ES3.SI"
              value={stock.symbol}
              onChange={(event) => handleSymbolInputChange(event.target.value)}
              onBlur={handleSymbolBlur}
              onKeyDown={(event) => handleDropdownKeyDown(event, "symbol")}
              aria-invalid={stock.symbolValidationError !== null}
              className="field-input font-mono"
            />
            {renderSuggestionDropdown("symbol")}
            {stock.symbolValidationError && (
              <p role="alert" className="mt-1.5 text-[12px] leading-4 text-loss">
                {stock.symbolValidationError}
              </p>
            )}
          </div>

          <div className="relative sm:col-span-7">
            <label
              htmlFor="tx-name"
              className="mb-1.5 block h-5 truncate text-[13px] font-medium leading-5 text-ink-2"
            >
              Company name
            </label>
            <input
              id="tx-name"
              type="text"
              autoComplete="off"
              placeholder="Apple or Ascendas"
              value={stock.instrumentName}
              onChange={(event) =>
                handleCompanyNameInputChange(event.target.value)
              }
              onBlur={handleCompanyNameBlur}
              onKeyDown={(event) => handleDropdownKeyDown(event, "name")}
              className="field-input"
            />
            {renderSuggestionDropdown("name")}
          </div>
        </div>

        {/* Quantity & Price — strictly single-line labels above, unit & freshness
            captions below so both input boxes align to the exact pixel */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label
              htmlFor="tx-quantity"
              className="mb-1.5 block h-5 truncate text-[13px] font-medium leading-5 text-ink-2"
            >
              {quantityLabel}
            </label>
            <div className="relative">
              <input
                id="tx-quantity"
                type="text"
                inputMode="decimal"
                required={type !== "Sell All"}
                disabled={type === "Sell All"}
                placeholder={type === "Dividend" ? "1.22" : "10"}
                value={type === "Sell All" ? "All open" : quantity}
                onChange={(event) => setQuantity(event.target.value)}
                className={`field-input num ${
                  type === "Dividend" ? "pr-12" : ""
                }`}
              />
              {type === "Dividend" && (
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-medium text-ink-2">
                  {stock.currency}
                </span>
              )}
            </div>
            {type === "Sell All" && (
              <p className="mt-1 text-[11.5px] leading-4 text-ink-3">
                {sellAllPortfolioCount > 1
                  ? `Sells every share across ${sellAllPortfolioCount} portfolios`
                  : "Sells entire position"}
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="tx-price"
              className="mb-1.5 block h-5 truncate text-[13px] font-medium leading-5 text-ink-2"
            >
              {priceLabel}
            </label>
            <div className="relative">
              <input
                id="tx-price"
                type="text"
                inputMode="decimal"
                required
                placeholder={isLoadingPrice ? "Loading…" : "0.00"}
                value={stock.price}
                onChange={(event) => {
                  commitStockState((prev) =>
                    applyManualPriceEdit(prev, event.target.value),
                  );
                }}
                className="field-input num pr-12"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-medium text-ink-2">
                {stock.currency}
              </span>
            </div>

            {isLoadingPrice ? (
              <p className="mt-1 inline-flex items-center gap-1 text-[11.5px] leading-4 text-accent">
                <Loader2 size={11} className="animate-spin" aria-hidden="true" />
                Fetching quote…
              </p>
            ) : stock.priceError ? (
              <p role="alert" className="mt-1 text-[11.5px] leading-4 text-loss">
                {stock.priceError}
              </p>
            ) : stock.isManualPrice ? (
              <p className="mt-1 text-[11.5px] font-medium leading-4 text-accent">
                Manual price
              </p>
            ) : stock.priceFreshnessLabel ? (
              <p className="mt-1 truncate text-[11.5px] leading-4 text-ink-3">
                {stock.priceFreshnessLabel}
              </p>
            ) : null}
          </div>
        </div>

        {/* FX Rate & Commission — strictly locked horizontal alignment */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label
              htmlFor="tx-fx"
              className="mb-1.5 block h-5 truncate text-[13px] font-medium leading-5 text-ink-2"
            >
              FX rate
            </label>
            {stock.currency === "SGD" ? (
              <div className="relative">
                <input
                  id="tx-fx"
                  type="text"
                  disabled
                  value="1.0000"
                  className="field-input num pr-12"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-medium text-ink-2">
                  SGD
                </span>
              </div>
            ) : (
              <div className="relative">
                <input
                  id="tx-fx"
                  type="text"
                  inputMode="decimal"
                  placeholder={isLoadingFx ? "Loading…" : "1.2816"}
                  value={stock.fxRateToSgd}
                  onChange={(event) => {
                    commitStockState((prev) =>
                      applyManualFxRateEdit(prev, event.target.value),
                    );
                  }}
                  className="field-input num pr-12"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-medium text-ink-2">
                  SGD
                </span>
              </div>
            )}

            {isLoadingFx ? (
              <p className="mt-1 inline-flex items-center gap-1 text-[11.5px] leading-4 text-accent">
                <Loader2 size={11} className="animate-spin" aria-hidden="true" />
                Fetching USD→SGD…
              </p>
            ) : stock.fxError ? (
              <p role="alert" className="mt-1 text-[11.5px] leading-4 text-loss">
                {stock.fxError}
              </p>
            ) : stock.isManualFxRate ? (
              <p className="mt-1 text-[11.5px] font-medium leading-4 text-accent">
                Manual rate
              </p>
            ) : stock.fxLabel ? (
              <p className="mt-1 truncate text-[11.5px] leading-4 text-ink-2">
                {stock.fxLabel}
              </p>
            ) : stock.currency === "USD" ? (
              <p className="mt-1 text-[11.5px] leading-4 text-ink-2">
                1 USD in SGD
              </p>
            ) : null}
          </div>

          <div>
            <label
              htmlFor="tx-commission"
              className="mb-1.5 block h-5 truncate text-[13px] font-medium leading-5 text-ink-2"
            >
              Commission
            </label>
            <input
              id="tx-commission"
              type="text"
              placeholder="0 or 1%"
              value={commission}
              onChange={(event) => setCommission(event.target.value)}
              className="field-input num"
            />
            <p className="mt-1 truncate text-[11.5px] leading-4 text-ink-2">
              Flat fee or % (e.g. 1%)
            </p>
          </div>
        </div>

        {/* Execution Date & Time */}
        <div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="tx-date"
                className="mb-1.5 block h-5 truncate text-[13px] font-medium leading-5 text-ink-2"
              >
                Date
              </label>
              <input
                id="tx-date"
                type="date"
                required
                value={date}
                onChange={(event) => handleDateChange(event.target.value)}
                className="field-input num"
              />
            </div>

            <div>
              <label
                htmlFor="tx-time"
                className="mb-1.5 block h-5 truncate text-[13px] font-medium leading-5 text-ink-2"
              >
                Time
              </label>
              <input
                id="tx-time"
                type="time"
                step={1}
                required
                value={time}
                onChange={(event) => setTime(event.target.value)}
                className="field-input num"
              />
            </div>
          </div>
          <p className="mt-1 text-[11.5px] leading-4 text-ink-2">
            Asia/Singapore (UTC+8) · saved in UTC
          </p>
        </div>

        {/* Backdate manual-override confirmation callout (Rule 16) */}
        {manualBackdateWarningDate !== null && (
          <div
            role="alert"
            className="rounded-[12px] border border-accent/35 bg-accent/10 px-3.5 py-3 text-[13px]"
          >
            <div className="flex items-start gap-2.5">
              <TriangleAlert
                size={16}
                className="mt-0.5 shrink-0 text-accent"
                aria-hidden="true"
              />
              <div className="space-y-2">
                <p className="leading-[1.4] text-ink">
                  Date changed to{" "}
                  <span className="font-mono font-medium">
                    {manualBackdateWarningDate}
                  </span>
                  . Confirm your manual entry matches this date, or load
                  historical values.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleLoadHistoricalReplacingManual}
                    className="inline-flex h-7.5 items-center gap-1.5 rounded-[8px] bg-accent px-2.5 text-[12px] font-medium text-accent-ink"
                  >
                    <RefreshCw size={12} aria-hidden="true" />
                    Load {manualBackdateWarningDate} values
                  </button>
                  <button
                    type="button"
                    onClick={() => setManualBackdateWarningDate(null)}
                    className="h-7.5 rounded-[8px] border border-line bg-surface px-2.5 text-[12px] font-medium text-ink-2 hover:text-ink"
                  >
                    Keep manual entry
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Optional Note */}
        <div>
          <label
            htmlFor="tx-notes"
            className="mb-1.5 block h-5 truncate text-[13px] font-medium leading-5 text-ink-2"
          >
            Note
          </label>
          <input
            id="tx-notes"
            type="text"
            placeholder="Optional note"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            className="field-input"
          />
        </div>

        {/* Apple Wallet–style SGD Snapshot Summary Card */}
        <div className="flex items-center justify-between gap-4 rounded-[12px] border border-line bg-field-bg px-4 py-3">
          <div className="min-w-0">
            <p className="text-[14px] font-medium tracking-[-0.01em] text-ink">
              Total in SGD
            </p>
            <p className="mt-0.5 truncate text-[12px] text-ink-2">
              {sgdSummarySubtitle}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="num text-[19px] font-semibold tracking-[-0.02em] text-ink">
              {sgdPreview ? formatMoney(sgdPreview.totalSgd, "SGD") : "—"}
            </p>
            {sgdPreview && stock.currency === "USD" && (
              <p className="num text-[11.5px] text-ink-2">
                {formatMoney(sgdPreview.nativeGross, "USD")}
              </p>
            )}
          </div>
        </div>

        {submitError !== null && (
          <p
            role="alert"
            className="rounded-[10px] border border-loss/30 bg-loss/10 px-3.5 py-2.5 text-[13.5px] text-loss"
          >
            {submitError}
          </p>
        )}

        {/* Responsive Apple Footer: 50/50 thumb buttons on mobile, right-aligned on desktop */}
        <div className="grid grid-cols-2 gap-2.5 pt-1 sm:flex sm:justify-end">
          <Button
            variant="secondary"
            onClick={onClose}
            className="w-full sm:w-auto sm:min-w-[96px]"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={isSubmitting || isVerifyingExactSymbol || !portfolioId}
            className="w-full sm:w-auto sm:min-w-[148px]"
          >
            {isSubmitting
              ? "Saving…"
              : editingTransaction
                ? "Save Changes"
                : "Save Transaction"}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
