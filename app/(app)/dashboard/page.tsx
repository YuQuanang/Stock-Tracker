import type { Metadata } from "next";
import { connection } from "next/server";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { CORE_COMPARISON_BENCHMARKS } from "@/lib/benchmarks/summary";
import { computePortfolioAnalytics } from "@/lib/services/analytics";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  await connection();
  const initialSnapshot = await computePortfolioAnalytics({
    includeBenchmarks: true,
    benchmarks: CORE_COMPARISON_BENCHMARKS.map((b) => b.symbol),
    includeFundamentals: true,
    cacheOnly: true,
  });

  return (
    <DashboardView
      initialSnapshot={initialSnapshot}
      hydrateLiveOnMount={!initialSnapshot.accountHasNoTransactions}
    />
  );
}
