import type { Metadata } from "next";
import { connection } from "next/server";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { PageHeader } from "@/components/ui/page-header";
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
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Real-time FIFO portfolio valuation, allocation breakdown, and risk-adjusted performance."
      />
      <DashboardView
        initialSnapshot={initialSnapshot}
        hydrateLiveOnMount={!initialSnapshot.accountHasNoTransactions}
      />
    </>
  );
}
