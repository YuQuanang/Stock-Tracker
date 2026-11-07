import type { Metadata } from "next";
import { connection } from "next/server";
import { TransactionsView } from "@/components/transactions/transactions-view";
import { PageHeader } from "@/components/ui/page-header";
import { backfillMissingTransactionSgdTotals } from "@/lib/services/fx-sgd";
import {
  computeLedgerSummaries,
  listCorporateActions,
  listEnrichedTransactions,
  listPortfolios,
} from "@/lib/services/ledger";

export const metadata: Metadata = { title: "Transactions" };

export default async function TransactionsPage() {
  // Always render at request time against the live ledger database.
  await connection();

  // Auto-populate historical USD -> SGD rates and SGD totals on any previously
  // imported or Sell All rows that have not been backfilled yet.
  await backfillMissingTransactionSgdTotals();

  const [portfolios, transactions, summary, corporateActions] =
    await Promise.all([
      listPortfolios(),
      listEnrichedTransactions(),
      computeLedgerSummaries(),
      listCorporateActions(),
    ]);

  return (
    <>
      <PageHeader
        title="Transactions"
        subtitle="Your buy, sell, sell-all, and dividend ledger — every position is derived from these records."
      />
      <TransactionsView
        portfolios={portfolios}
        transactions={transactions}
        positions={summary.positions}
        zeroCostBuys={summary.zeroCostBuys}
        corporateActions={corporateActions}
      />
    </>
  );
}
