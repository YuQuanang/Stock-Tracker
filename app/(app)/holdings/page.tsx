import type { Metadata } from "next";
import { connection } from "next/server";
import { HoldingsView } from "@/components/holdings/holdings-view";
import { PageHeader } from "@/components/ui/page-header";
import { getHoldingsPageSnapshot } from "@/lib/services/holdings";

export const metadata: Metadata = { title: "Holdings" };

export default async function HoldingsPage() {
  await connection();
  const snapshot = await getHoldingsPageSnapshot({ cacheOnly: true });

  return (
    <>
      <PageHeader
        title="Holdings"
        subtitle="Open and closed FIFO positions in native currency and SGD."
      />
      <HoldingsView
        portfolios={snapshot.portfolios}
        defaultPortfolioId={snapshot.defaultPortfolioId}
        buckets={snapshot.buckets}
        initialQuotes={snapshot.initialQuotes}
        initialFxUsdToSgd={snapshot.initialFxUsdToSgd}
        initialMarket={snapshot.initialMarket}
        baseCurrency={snapshot.baseCurrency}
      />
    </>
  );
}
