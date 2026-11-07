import type { Metadata } from "next";
import { connection } from "next/server";
import { ImportExportView } from "@/components/import-export/import-export-view";
import { PageHeader } from "@/components/ui/page-header";
import { listCsvImportLogs } from "@/lib/services/csv-import-export";
import { listPortfolios } from "@/lib/services/ledger";

export const metadata: Metadata = { title: "Import / Export" };

export default async function ImportExportPage() {
  // Always render against live database state at request time.
  await connection();

  const [portfolios, importLogs] = await Promise.all([
    listPortfolios(),
    listCsvImportLogs(),
  ]);

  return (
    <>
      <PageHeader
        title="Import / Export"
        subtitle="Lossless Microsoft Start CSV round-tripping, validation preview, and one-click portfolio backups."
      />
      <ImportExportView
        initialPortfolios={portfolios}
        initialImportLogs={importLogs}
      />
    </>
  );
}
