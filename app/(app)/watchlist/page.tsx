import type { Metadata } from "next";
import { connection } from "next/server";
import { WatchlistView } from "@/components/watchlist/watchlist-view";
import { getWatchlistPageSnapshot } from "@/lib/services/watchlist";

export const metadata: Metadata = { title: "Watchlist" };

export default async function WatchlistPage() {
  await connection();
  const snapshot = await getWatchlistPageSnapshot();

  return (
    <WatchlistView
      portfolios={snapshot.portfolios}
      positions={snapshot.positions}
      items={snapshot.items}
      initialQuotes={snapshot.initialQuotes}
      initialFxUsdToSgd={snapshot.initialFxUsdToSgd}
      initialMarket={snapshot.initialMarket}
      baseCurrency={snapshot.baseCurrency}
      defaultBenchmark={snapshot.defaultBenchmark}
    />
  );
}
