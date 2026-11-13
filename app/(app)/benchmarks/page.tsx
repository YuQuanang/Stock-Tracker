import type { Metadata } from "next";
import { connection } from "next/server";
import { BenchmarksView } from "@/components/benchmarks/benchmarks-view";
import { PageHeader } from "@/components/ui/page-header";
import { computePortfolioAnalytics } from "@/lib/services/analytics";

export const metadata: Metadata = { title: "Benchmarks" };

export default async function BenchmarksPage() {
  await connection();
  const initialSnapshot = await computePortfolioAnalytics({
    includeBenchmarks: true,
    includeFundamentals: false,
  });

  return (
    <>
      <PageHeader
        title="Benchmarks"
        subtitle="Currency-aligned Time-Weighted Return, same-cash-flow simulations, and CAPM risk metrics."
      />
      <BenchmarksView initialSnapshot={initialSnapshot} />
    </>
  );
}
