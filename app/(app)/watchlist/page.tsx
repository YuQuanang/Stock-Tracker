import type { Metadata } from "next";
import { Eye } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = { title: "Watchlist" };

export default function WatchlistPage() {
  return (
    <>
      <PageHeader title="Watchlist" subtitle="Stocks you follow but do not own." />
      <EmptyState
        icon={Eye}
        title="Your watchlist is empty"
        description="Add a symbol to follow how it performs, or simulate what would have happened if you had bought it. Watchlists arrive in a later milestone."
      />
    </>
  );
}

