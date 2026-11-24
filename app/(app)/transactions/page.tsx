import type { Metadata } from "next";
import { connection } from "next/server";
import { TransactionsView } from "@/components/transactions/transactions-view";
import { PageHeader } from "@/components/ui/page-header";
import { syncPortfolioDividends } from "@/lib/services/dividends";
import { backfillMissingTransactionSgdTotals } from "@/lib/services/fx-sgd";
import {
  computeLedgerSummaries,
  getOrCreateSettings,
  listCorporateActions,
  listEnrichedTransactions,
  listPortfolios,
  resolveDefaultPortfolioId,
} from "@/lib/services/ledger";

export const metadata: Metadata = { title: "Transactions" };

export default async function TransactionsPage() {
  // Always render at request time against the live ledger database.
  await connection();

  // Auto-sync historical cash dividends and populate historical USD -> SGD rates.
  await syncPortfolioDividends();
  await backfillMissingTransactionSgdTotals();

  const [appSettings, portfolios, transactions, summary, corporateActions] =
    await Promise.all([
      getOrCreateSettings(),
      listPortfolios(),
      listEnrichedTransactions(),
      computeLedgerSummaries(),
      listCorporateActions(),
    ]);

  const defaultPortfolioId = resolveDefaultPortfolioId(
    appSettings.defaultPortfolioId,
    portfolios,
  );

  return (
    <>
      <PageHeader
        title="Transactions"
        subtitle="Your buy, sell, sell-all, and dividend ledger — every position is derived from these records."
      />
      <TransactionsView
        portfolios={portfolios}
        defaultPortfolioId={defaultPortfolioId}
        transactions={transactions}
        positions={summary.positions}
        zeroCostBuys={summary.zeroCostBuys}
        corporateActions={corporateActions}
      />
    </>
  );
}
