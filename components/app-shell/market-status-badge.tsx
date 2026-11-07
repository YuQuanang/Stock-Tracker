"use client";

import { useSyncExternalStore } from "react";
import {
  type CombinedMarketOverview,
  type ExtendedMarketSessionStatus,
  getCombinedMarketOverview,
} from "@/lib/market-data/hours";

interface MarketStatusBadgeProps {
  /** Compact stacked `US` / `SGX` badges for the collapsed desktop sidebar. */
  compact?: boolean;
  /** `"sidebar"` stacks US & SGX vertically; `"inline"` places them side-by-side on mobile. */
  layout?: "sidebar" | "inline";
}

let cachedSnapshotMinute = -1;
let cachedOverview: CombinedMarketOverview | null = null;

function subscribeMinuteTick(onStoreChange: () => void): () => void {
  const intervalId = setInterval(onStoreChange, 60_000);
  return () => clearInterval(intervalId);
}

function getClientMarketSnapshot(): CombinedMarketOverview {
  const now = new Date();
  const currentMinute = Math.floor(now.getTime() / 60_000);
  if (cachedOverview === null || cachedSnapshotMinute !== currentMinute) {
    cachedSnapshotMinute = currentMinute;
    cachedOverview = getCombinedMarketOverview(now);
  }
  return cachedOverview;
}

function getServerMarketSnapshot(): CombinedMarketOverview | null {
  return null;
}

function formatScheduleLine(
  session: ExtendedMarketSessionStatus | null,
): string {
  if (!session) {
    return "Checking schedule…";
  }
  if (session.isOpen) {
    return session.closesAtSgtLabel
      ? `Closes ${session.closesAtSgtLabel}`
      : "Regular session";
  }
  return session.nextOpenSgtLabel
    ? `Opens ${session.nextOpenSgtLabel}`
    : "Market closed";
}

function StatusDot({ isOpen }: { isOpen: boolean }) {
  return (
    <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
      {isOpen && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-gain opacity-70" />
      )}
      <span
        className={`relative inline-flex h-2 w-2 rounded-full ${
          isOpen ? "bg-gain" : "bg-ink-3/75"
        }`}
      />
    </span>
  );
}

/**
 * Dual live exchange-session indicators for **US (`NYSE`/`NASDAQ`)** and
 * **Singapore (`SGX`)** regular trading hours in `Asia/Singapore` (`UTC+8`).
 *
 * Designed with zero text truncation so the market, open/closed status, day of
 * week, and exact time in SGT are always 100% readable on desktop and mobile.
 */
export function MarketStatusBadge({
  compact = false,
  layout = "sidebar",
}: MarketStatusBadgeProps) {
  const overview = useSyncExternalStore(
    subscribeMinuteTick,
    getClientMarketSnapshot,
    getServerMarketSnapshot,
  );

  const venues = [
    {
      code: "US",
      fullLabel: "US (NYSE / NASDAQ)",
      session: overview?.us ?? null,
    },
    {
      code: "SGX",
      fullLabel: "Singapore (SGX)",
      session: overview?.sg ?? null,
    },
  ] as const;

  if (compact) {
    return (
      <div
        role="status"
        aria-label={overview?.detailLabel ?? "US and SGX market hours"}
        className="flex flex-col items-center gap-1.5"
      >
        {venues.map(({ code, fullLabel, session }) => {
          const isOpen = session?.isOpen ?? false;
          const schedule = formatScheduleLine(session);
          return (
            <div
              key={code}
              title={`${fullLabel}: ${isOpen ? "Open" : "Closed"} · ${schedule}`}
              className="flex w-12 items-center justify-center gap-1.5 rounded-lg border border-line bg-surface-2/80 px-1.5 py-1 text-[10.5px] font-semibold text-ink-2"
            >
              <StatusDot isOpen={isOpen} />
              <span>{code}</span>
            </div>
          );
        })}
      </div>
    );
  }

  if (layout === "inline") {
    return (
      <div
        role="status"
        aria-label={overview?.detailLabel ?? "US and SGX market hours"}
        className="grid w-full grid-cols-2 gap-2"
      >
        {venues.map(({ code, fullLabel, session }) => {
          const isOpen = session?.isOpen ?? false;
          const schedule = formatScheduleLine(session);
          return (
            <div
              key={code}
              title={fullLabel}
              className="rounded-[11px] border border-line bg-surface-2/75 px-2.5 py-1.5"
            >
              <div className="flex items-center justify-between gap-1.5 text-[11.5px] leading-4">
                <span className="inline-flex items-center gap-1.5 font-semibold text-ink">
                  <StatusDot isOpen={isOpen} />
                  <span>{code}</span>
                </span>
                <span
                  className={
                    isOpen ? "font-medium text-gain" : "font-medium text-ink-3"
                  }
                >
                  {session ? (isOpen ? "Open" : "Closed") : "…"}
                </span>
              </div>
              <p className="num mt-0.5 text-[11px] leading-4 text-ink-2">
                {schedule}
              </p>
            </div>
          );
        })}
      </div>
    );
  }

  // Default `"sidebar"` layout: clean Apple grouped card with US & SGX stacked
  return (
    <div
      role="status"
      aria-label={overview?.detailLabel ?? "US and SGX market hours"}
      className="divide-y divide-line rounded-[var(--radius-control)] border border-line bg-surface-2/70"
    >
      {venues.map(({ code, fullLabel, session }) => {
        const isOpen = session?.isOpen ?? false;
        const schedule = formatScheduleLine(session);
        return (
          <div key={code} title={fullLabel} className="px-3 py-2">
            <div className="flex items-center justify-between gap-2 text-[12px] leading-4">
              <span className="inline-flex items-center gap-1.5 font-semibold text-ink">
                <StatusDot isOpen={isOpen} />
                <span>{code} Market</span>
              </span>
              <span
                className={
                  isOpen ? "font-medium text-gain" : "font-medium text-ink-3"
                }
              >
                {session ? (isOpen ? "Open" : "Closed") : "…"}
              </span>
            </div>
            <p className="num mt-0.5 text-[11.5px] leading-4 text-ink-2">
              {schedule}
            </p>
          </div>
        );
      })}
    </div>
  );
}
