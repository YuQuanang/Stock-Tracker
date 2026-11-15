"use client";

import { AlertCircle, Check, Loader2, Plus, Search } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import type { SymbolSearchMatch } from "@/lib/market-data/search";
import {
  ClientMarketError,
  isAbortError,
  searchStocksClient,
} from "@/lib/transactions/client-market-api";
import {
  formatExchangeCodeForDisplay,
  formatSymbolForDisplay,
} from "@/lib/transactions/form-logic";

const SEARCH_DEBOUNCE_MS = 300;

interface AddSymbolSheetProps {
  isOpen: boolean;
  onClose: () => void;
  portfolioId: string;
  portfolioName: string;
  existingSymbols: string[];
  onAdded: () => void;
}

export function AddSymbolSheet({
  isOpen,
  onClose,
  portfolioId,
  portfolioName,
  existingSymbols,
  onAdded,
}: AddSymbolSheetProps) {
  if (!isOpen) {
    return null;
  }

  return (
    <Sheet
      isOpen={isOpen}
      onClose={onClose}
      title="Add to watchlist"
      description={`Search live tickers or company names for “${portfolioName}”. The latest price is recorded automatically when available.`}
      maxWidthClass="max-w-lg"
    >
      <AddSymbolSheetForm
        portfolioId={portfolioId}
        existingSymbols={existingSymbols}
        onClose={onClose}
        onAdded={onAdded}
      />
    </Sheet>
  );
}

function AddSymbolSheetForm({
  portfolioId,
  existingSymbols,
  onClose,
  onAdded,
}: Omit<AddSymbolSheetProps, "isOpen" | "portfolioName">) {
  const existingSet = new Set(existingSymbols.map((s) => s.toUpperCase()));

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<SymbolSearchMatch | null>(null);
  const [alertAbove, setAlertAbove] = useState("");
  const [alertBelow, setAlertBelow] = useState("");

  const [isSearching, setIsSearching] = useState(false);
  const [matches, setMatches] = useState<SymbolSearchMatch[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchedQuery, setSearchedQuery] = useState("");

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAdded, setIsAdded] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const searchSeqRef = useRef(0);
  const searchAbortRef = useRef<AbortController | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cacheRef = useRef(new Map<string, SymbolSearchMatch[]>());

  useEffect(() => {
    const trimmed = query.trim();
    if (selected && trimmed.toUpperCase() === selected.symbol.toUpperCase()) {
      return;
    }

    if (trimmed.length < 1) {
      searchAbortRef.current?.abort();
      queueMicrotask(() => {
        setIsSearching(false);
        setMatches([]);
        setSearchError(null);
        setSearchedQuery("");
      });
      return;
    }

    const cacheKey = trimmed.toUpperCase();
    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      queueMicrotask(() => {
        setIsSearching(false);
        setMatches(cached);
        setSearchError(null);
        setSearchedQuery(trimmed);
      });
      return;
    }

    const seq = ++searchSeqRef.current;
    const timer = window.setTimeout(async () => {
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;

      setIsSearching(true);
      setSearchError(null);

      try {
        const results = await searchStocksClient(trimmed, {
          signal: controller.signal,
        });
        if (seq !== searchSeqRef.current) {
          return;
        }
        cacheRef.current.set(cacheKey, results);
        setMatches(results);
        setSearchedQuery(trimmed);
        setIsSearching(false);
      } catch (err) {
        if (isAbortError(err) || seq !== searchSeqRef.current) {
          return;
        }
        const message =
          err instanceof ClientMarketError
            ? err.message
            : "Network error while searching symbols.";
        setSearchError(message);
        setMatches([]);
        setSearchedQuery(trimmed);
        setIsSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [query, selected]);

  useEffect(() => {
    return () => {
      searchAbortRef.current?.abort();
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  async function submitSymbol(target: {
    symbol: string;
    name?: string | null;
    exchangeCode?: string | null;
    currency?: "USD" | "SGD" | null;
  }) {
    setSubmitError(null);
    setIsSubmitting(true);
    setIsAdded(false);

    try {
      const response = await fetch("/api/watchlists/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          portfolioId,
          symbol: target.symbol,
          name: target.name ?? null,
          exchangeCode: target.exchangeCode ?? null,
          currency: target.currency ?? null,
          alertAbove: alertAbove.trim() || null,
          alertBelow: alertBelow.trim() || null,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        setSubmitError(data.error ?? "Unable to add symbol to watchlist.");
        setIsSubmitting(false);
        return;
      }

      setIsSubmitting(false);
      setIsAdded(true);
      onAdded();
      const reducedMotion =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      closeTimerRef.current = setTimeout(
        () => {
          onClose();
        },
        reducedMotion ? 80 : 380,
      );
    } catch {
      setSubmitError("Network error while saving watchlist item.");
      setIsSubmitting(false);
    }
  }

  async function handleFormSubmit(event: FormEvent) {
    event.preventDefault();
    if (!selected) {
      const fallbackSymbol = query.trim().toUpperCase();
      if (!fallbackSymbol) {
        setSubmitError("Search and select a symbol first.");
        return;
      }
      await submitSymbol({ symbol: fallbackSymbol });
      return;
    }

    await submitSymbol({
      symbol: selected.symbol,
      name: selected.name,
      exchangeCode: selected.exchangeCode,
      currency: selected.currency,
    });
  }

  return (
    <form onSubmit={handleFormSubmit} className="space-y-4">
      <div>
        <label
          htmlFor="watchlist-symbol-search"
          className="mb-1.5 block text-[13px] font-medium text-ink-2"
        >
          Ticker or company name
        </label>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3"
            aria-hidden="true"
          />
          <input
            id="watchlist-symbol-search"
            type="text"
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(null);
              setSubmitError(null);
            }}
            placeholder="Search AAPL, Apple, DBS, D05.SI..."
            className="field-input pl-9.5 pr-9"
          />
          {isSearching && (
            <Loader2
              className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-ink-3"
              aria-hidden="true"
            />
          )}
        </div>

        {/* Live search results */}
        {!selected &&
          (isSearching ||
            searchError ||
            matches.length > 0 ||
            searchedQuery) && (
            <div className="mt-2 max-h-60 divide-y divide-line overflow-y-auto rounded-[12px] border border-line bg-surface">
              {isSearching && matches.length === 0 && (
                <div className="divide-y divide-line" aria-busy="true">
                  {Array.from({ length: 3 }).map((_, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between gap-3 px-3.5 py-2.5"
                    >
                      <div className="space-y-1.5">
                        <Skeleton className="h-4 w-20" />
                        <Skeleton className="h-3 w-40" />
                      </div>
                      <Skeleton className="h-4 w-12" />
                    </div>
                  ))}
                </div>
              )}

              {searchError && (
                <div className="flex items-center gap-2 px-3.5 py-3 text-[13px] text-loss">
                  <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{searchError}</span>
                </div>
              )}

              {!isSearching &&
                !searchError &&
                matches.length === 0 &&
                searchedQuery && (
                  <div className="px-3.5 py-3 text-[13px] text-ink-2">
                    No matching symbols found for &ldquo;{searchedQuery}&rdquo;.
                  </div>
                )}

              {matches.map((match) => {
                const alreadyAdded = existingSet.has(match.symbol.toUpperCase());
                return (
                  <button
                    key={`${match.symbol}::${match.exchangeCode}`}
                    type="button"
                    disabled={alreadyAdded}
                    onClick={() => {
                      setSelected(match);
                      setQuery(match.symbol);
                      setSubmitError(null);
                    }}
                    className="flex w-full cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[14px] font-semibold text-ink">
                          {formatSymbolForDisplay(match.symbol)}
                        </span>
                        <span className="rounded-[6px] bg-surface-2 px-1.5 py-0.5 text-[10.5px] font-medium text-ink-2">
                          {match.exchangeDisplay ||
                            formatExchangeCodeForDisplay(match.exchangeCode) ||
                            match.currency}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-[12px] text-ink-2">
                        {match.name}
                      </p>
                    </div>

                    {alreadyAdded ? (
                      <span className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-ink-2">
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        In list
                      </span>
                    ) : (
                      <span className="shrink-0 text-[12.5px] font-medium text-accent">
                        Select
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
      </div>

      {selected && (
        <div className="flex items-center justify-between gap-3 rounded-[12px] border border-line bg-surface-2 px-3.5 py-2.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[14px] font-semibold text-ink">
                {formatSymbolForDisplay(selected.symbol)}
              </span>
              <span className="rounded-[6px] border border-line bg-surface px-1.5 py-0.5 text-[10.5px] font-medium text-ink-2">
                {selected.exchangeDisplay || selected.currency}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[12px] text-ink-2">
              {selected.name}
            </p>
          </div>
          <span className="shrink-0 text-[12px] font-semibold text-accent">
            Ready to add
          </span>
        </div>
      )}

      {/* Optional price alerts */}
      <div className="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-2">
        <div>
          <label
            htmlFor="watchlist-add-alert-above"
            className="mb-1.5 block text-[12.5px] font-medium text-ink-2"
          >
            Alert above (optional)
          </label>
          <input
            id="watchlist-add-alert-above"
            type="text"
            inputMode="decimal"
            value={alertAbove}
            onChange={(e) => setAlertAbove(e.target.value)}
            placeholder={
              selected?.currency === "SGD" ? "e.g. 42.50" : "e.g. 250.00"
            }
            className="field-input num"
          />
        </div>
        <div>
          <label
            htmlFor="watchlist-add-alert-below"
            className="mb-1.5 block text-[12.5px] font-medium text-ink-2"
          >
            Alert below (optional)
          </label>
          <input
            id="watchlist-add-alert-below"
            type="text"
            inputMode="decimal"
            value={alertBelow}
            onChange={(e) => setAlertBelow(e.target.value)}
            placeholder={
              selected?.currency === "SGD" ? "e.g. 34.00" : "e.g. 180.00"
            }
            className="field-input num"
          />
        </div>
      </div>

      {submitError && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-[10px] bg-loss/10 px-3.5 py-2.5 text-[13px] text-loss"
        >
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{submitError}</span>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
        <Button
          type="button"
          variant="ghost"
          onClick={onClose}
          disabled={isSubmitting || isAdded}
          className="px-4 py-2 text-[14px]"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={
            isSubmitting || isAdded || (!selected && query.trim().length === 0)
          }
          className="px-4 py-2 text-[14px]"
        >
          {isAdded ? (
            <>
              <Check className="h-4 w-4" aria-hidden="true" />
              Added ✓
            </>
          ) : isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Adding...
            </>
          ) : (
            <>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add symbol
            </>
          )}
        </Button>
      </div>
    </form>
  );
}
