import type { Metadata } from "next";
import { ChartLine } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = { title: "Benchmarks" };

export default function BenchmarksPage() {
  return (
    <>
      <PageHeader
        title="Benchmarks"
        subtitle="Compare your portfolio with the S&P 500, NASDAQ, Dow Jones and STI."
      />
      <EmptyState
        icon={ChartLine}
        title="Nothing to compare yet"
        description="Benchmark comparison needs transactions and price history. Import your CSV first, and the comparison will appear here."
      />
    </>
  );
}

