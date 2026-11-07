"use client";

/**
 * Smart Short-Polling Hook for Live & Near-Live Market Quotes (`hooks/use-quotes-poll.ts`).
 *
 * Designed for Vercel's free Hobby plan (short stateless HTTP GETs instead of
 * long-lived SSE connections) and respectful of exchange trading hours:
 *  - Fetches once immediately whenever the tracked `symbols` set changes.
 *  - When **all markets are closed** (weekends such as Saturday 2026-11-07,
 *    public holidays, or outside SGX + US regular sessions): schedules **zero**
 *    background polling timers.
 *  - When **any market is open**: polls every 12s while the tab is visible and
 *    slows to 45s while hidden in a background tab.
 *  - Automatically refreshes when returning to a tab (`visibilitychange`) or
 *    reconnecting (`online`) if the snapshot is stale.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ResolvedInstrumentQuote } from "@/lib/market-data/batch-quotes";
import type { ExchangeRateSnapshot } from "@/lib/market-data/fx";
import {
  type CombinedMarketOverview,
  getCombinedMarketOverview,
} from "@/lib/market-data/hours";

export interface QuotesBatchApiResponse {
  quotes: Record<string, ResolvedInstrumentQuote>;
  fxUsdToSgd: ExchangeRateSnapshot | null;
  market: CombinedMarketOverview;
  fetchedAt: string;
}

export interface UseQuotesPollOptions {
  symbols: readonly string[];
  includeSparklines?: boolean;
  enabled?: boolean;
  initialQuotes?: Record<string, ResolvedInstrumentQuote>;
  initialFxUsdToSgd?: ExchangeRateSnapshot | null;
  initialMarket?: CombinedMarketOverview;
}

export interface UseQuotesPollResult {
  quotes: Record<string, ResolvedInstrumentQuote>;
  fxUsdToSgd: ExchangeRateSnapshot | null;
  market: CombinedMarketOverview;
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  lastUpdatedAt: string | null;
  refreshNow: () => Promise<void>;
}

const CLOSED_FOCUS_REFRESH_AGE_MS = 5 * 60 * 1000; // 5 minutes

export function useQuotesPoll(
  options: UseQuotesPollOptions,
): UseQuotesPollResult {
  const enabled = options.enabled ?? true;
  const includeSparklines = options.includeSparklines ?? false;

  // Canonicalize symbol list so array identity changes never re-trigger fetches.
  const symbolsKey = useMemo(() => {
    const cleaned = [
      ...new Set(options.symbols.map((s) => s.trim()).filter(Boolean)),
    ];
    return cleaned.join(",");
  }, [options.symbols]);

  const [quotes, setQuotes] = useState<Record<string, ResolvedInstrumentQuote>>(
    () => options.initialQuotes ?? {},
  );
  const [fxUsdToSgd, setFxUsdToSgd] = useState<ExchangeRateSnapshot | null>(
    () => options.initialFxUsdToSgd ?? null,
  );
  const [market, setMarket] = useState<CombinedMarketOverview>(
    () => options.initialMarket ?? getCombinedMarketOverview(),
  );
  const [isLoading, setIsLoading] = useState<boolean>(
    () =>
      enabled &&
      symbolsKey.length > 0 &&
      Object.keys(options.initialQuotes ?? {}).length === 0,
  );
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);

  const lastFetchedMsRef = useRef<number>(0);
  const requestSeqRef = useRef<number>(0);
  const abortRef = useRef<AbortController | null>(null);
  const hasLoadedOnceRef = useRef<boolean>(
    Object.keys(options.initialQuotes ?? {}).length > 0,
  );

  const fetchBatch = useCallback(async (): Promise<void> => {
    if (!enabled) {
      return;
    }
    if (!symbolsKey) {
      setMarket(getCombinedMarketOverview());
      setIsLoading(false);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;

    if (!hasLoadedOnceRef.current) {
      setIsLoading(true);
    } else {
      setIsRefreshing(true);
    }

    try {
      const searchParams = new URLSearchParams({ symbols: symbolsKey });
      if (includeSparklines) {
        searchParams.set("sparklines", "1");
      }

      const response = await fetch(`/api/quotes?${searchParams.toString()}`, {
        method: "GET",
        signal: controller.signal,
        cache: "no-store",
      });

      if (seq !== requestSeqRef.current) {
        return;
      }

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(body?.error ?? "Could not refresh market quotes.");
        return;
      }

      const payload = (await response.json()) as QuotesBatchApiResponse;
      if (seq !== requestSeqRef.current) {
        return;
      }

      hasLoadedOnceRef.current = true;
      lastFetchedMsRef.current = Date.now();
      setQuotes((prev) => ({ ...prev, ...payload.quotes }));
      if (payload.fxUsdToSgd) {
        setFxUsdToSgd(payload.fxUsdToSgd);
      }
      setMarket(payload.market);
      setLastUpdatedAt(payload.fetchedAt);
      setError(null);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      if (seq === requestSeqRef.current) {
        setError("Network error while refreshing market prices.");
      }
    } finally {
      if (seq === requestSeqRef.current) {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    }
  }, [enabled, symbolsKey, includeSparklines]);

  // 1. Initial fetch whenever enabled or tracked symbol set changes
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        void fetchBatch();
      }
    });
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [fetchBatch]);

  // 2. Adaptive short-polling loop (runs ONLY while at least one market is open)
  useEffect(() => {
    if (!enabled || !symbolsKey || !market.anyMarketOpen) {
      return;
    }

    let timerId: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    function getIntervalMs(): number | null {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return market.recommendedPollMs.hiddenMs ?? 45_000;
      }
      return market.recommendedPollMs.visibleMs ?? 12_000;
    }

    function scheduleNext(): void {
      if (cancelled) {
        return;
      }
      const delay = getIntervalMs();
      if (delay === null) {
        return;
      }
      timerId = setTimeout(async () => {
        if (cancelled) {
          return;
        }
        if (typeof navigator === "undefined" || navigator.onLine !== false) {
          await fetchBatch();
        }
        scheduleNext();
      }, delay);
    }

    scheduleNext();

    return () => {
      cancelled = true;
      if (timerId !== null) {
        clearTimeout(timerId);
      }
    };
  }, [
    enabled,
    symbolsKey,
    market.anyMarketOpen,
    market.recommendedPollMs.visibleMs,
    market.recommendedPollMs.hiddenMs,
    fetchBatch,
  ]);

  // 3. Refresh on tab focus or network reconnect when data has aged
  useEffect(() => {
    if (!enabled || !symbolsKey) {
      return;
    }

    function handleResumeCheck(): void {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      const freshMarket = getCombinedMarketOverview();
      setMarket(freshMarket);

      const ageMs = Date.now() - lastFetchedMsRef.current;
      const thresholdMs = freshMarket.anyMarketOpen
        ? (freshMarket.recommendedPollMs.visibleMs ?? 12_000)
        : CLOSED_FOCUS_REFRESH_AGE_MS;

      if (ageMs >= thresholdMs) {
        void fetchBatch();
      }
    }

    document.addEventListener("visibilitychange", handleResumeCheck);
    window.addEventListener("online", handleResumeCheck);
    return () => {
      document.removeEventListener("visibilitychange", handleResumeCheck);
      window.removeEventListener("online", handleResumeCheck);
    };
  }, [enabled, symbolsKey, fetchBatch]);

  return {
    quotes,
    fxUsdToSgd,
    market,
    isLoading,
    isRefreshing,
    error,
    lastUpdatedAt,
    refreshNow: fetchBatch,
  };
}
