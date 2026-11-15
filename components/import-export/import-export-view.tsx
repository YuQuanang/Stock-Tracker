"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import {
  AlertCircle,
  ArrowDownToLine,
  CheckCircle2,
  ChevronDown,
  DatabaseBackup,
  FileSpreadsheet,
  FileUp,
  History,
  RotateCcw,
  TriangleAlert,
  X,
} from "lucide-react";
import type { Portfolio } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { getButtonClasses } from "@/components/ui/button-styles";
import { Card } from "@/components/ui/card";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { writeRejectedRowsCsv } from "@/lib/csv/msp-writer";
import type {
  CsvCommitResult,
  CsvImportLogEntry,
  CsvPreviewResponse,
  DuplicateImportMode,
} from "@/lib/services/csv-import-export";

const DUPLICATE_MODE_OPTIONS: readonly {
  value: DuplicateImportMode;
  label: string;
}[] = [
  { value: "skip", label: "Skip duplicates" },
  { value: "replace", label: "Replace portfolio" },
  { value: "append", label: "Append all" },
];

const DUPLICATE_MODE_DESCRIPTIONS: Record<DuplicateImportMode, string> = {
  skip: "Keeps existing records and skips incoming transactions whose portfolio, symbol, type, quantity, price, and timestamp already match.",
  replace:
    "Replaces all existing transactions and tracked symbols inside the portfolios included in this CSV file.",
  append:
    "Imports every valid transaction row even when an identical record already exists in the portfolio.",
};

function formatSgtTimestamp(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-SG", {
      timeZone: "Asia/Singapore",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

interface ImportExportViewProps {
  initialPortfolios: Portfolio[];
  initialImportLogs: CsvImportLogEntry[];
}

export function ImportExportView({
  initialPortfolios,
  initialImportLogs,
}: ImportExportViewProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [portfolios, setPortfolios] = useState<Portfolio[]>(initialPortfolios);
  const [importLogs, setImportLogs] =
    useState<CsvImportLogEntry[]>(initialImportLogs);

  // Upload & preview state
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFilename, setSelectedFilename] = useState<string | null>(null);
  const [selectedCsvText, setSelectedCsvText] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [preview, setPreview] = useState<CsvPreviewResponse | null>(null);
  const [duplicateMode, setDuplicateMode] =
    useState<DuplicateImportMode>("skip");

  // Commit & feedback state
  const [isCommitting, setIsCommitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [commitResult, setCommitResult] = useState<CsvCommitResult | null>(
    null,
  );

  // Export filter state
  const [exportPortfolioId, setExportPortfolioId] = useState<string>("all");

  // Undo confirmation state
  const [confirmUndoId, setConfirmUndoId] = useState<string | null>(null);
  const [undoingId, setUndoingId] = useState<string | null>(null);
  const [undoFeedback, setUndoFeedback] = useState<string | null>(null);

  async function loadPreviewForFile(file: File) {
    setErrorMessage(null);
    setCommitResult(null);
    setUndoFeedback(null);
    setIsPreviewLoading(true);

    try {
      const text = await file.text();
      const response = await fetch("/api/import-export/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvText: text }),
      });

      const payload = (await response.json().catch(() => null)) as {
        preview?: CsvPreviewResponse;
        error?: string;
      } | null;

      if (!response.ok || !payload?.preview) {
        setPreview(null);
        setSelectedFilename(null);
        setSelectedCsvText(null);
        setErrorMessage(
          payload?.error ?? "Unable to parse or preview the selected CSV file.",
        );
        return;
      }

      setSelectedFilename(file.name);
      setSelectedCsvText(text);
      setPreview(payload.preview);
      setDuplicateMode("skip");
    } catch {
      setErrorMessage(
        "Could not read the selected file. Please check the file and try again.",
      );
    } finally {
      setIsPreviewLoading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      void loadPreviewForFile(file);
    }
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!isDragging) {
      setIsDragging(true);
    }
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);

    const file = event.dataTransfer.files?.[0];
    if (file) {
      void loadPreviewForFile(file);
    }
  }

  function clearPreview() {
    setPreview(null);
    setSelectedFilename(null);
    setSelectedCsvText(null);
    setErrorMessage(null);
  }

  function handleDownloadRejectedCsv() {
    if (!preview || preview.rejectedRows.length === 0) {
      return;
    }
    const csvContent = writeRejectedRowsCsv(
      preview.headers,
      preview.rejectedRows,
    );
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const baseName = (selectedFilename ?? "import").replace(/\.csv$/i, "");
    anchor.href = url;
    anchor.download = `${baseName}-rejected-rows.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  async function handleCommitImport() {
    if (!preview || !selectedCsvText || !selectedFilename) {
      return;
    }

    setIsCommitting(true);
    setErrorMessage(null);

    try {
      const response = await fetch("/api/import-export/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: selectedFilename,
          csvText: selectedCsvText,
          duplicateMode,
        }),
      });

      const payload = (await response.json().catch(() => null)) as {
        result?: CsvCommitResult;
        portfolios?: Portfolio[];
        importLogs?: CsvImportLogEntry[];
        error?: string;
      } | null;

      if (!response.ok || !payload?.result) {
        setErrorMessage(
          payload?.error ?? "Import failed. No changes were saved.",
        );
        return;
      }

      setCommitResult(payload.result);
      if (payload.portfolios) {
        setPortfolios(payload.portfolios);
      }
      if (payload.importLogs) {
        setImportLogs(payload.importLogs);
      }
      setPreview(null);
      setSelectedFilename(null);
      setSelectedCsvText(null);
      router.refresh();
    } catch {
      setErrorMessage(
        "Network error while committing import. Please try again.",
      );
    } finally {
      setIsCommitting(false);
    }
  }

  async function handleUndoImport(importId: string) {
    setUndoingId(importId);
    setErrorMessage(null);
    setUndoFeedback(null);

    try {
      const response = await fetch(`/api/import-export/undo/${importId}`, {
        method: "POST",
      });

      const payload = (await response.json().catch(() => null)) as {
        portfolios?: Portfolio[];
        importLogs?: CsvImportLogEntry[];
        error?: string;
      } | null;

      if (!response.ok) {
        setErrorMessage(
          payload?.error ?? "Could not undo this import.",
        );
        return;
      }

      if (payload?.portfolios) {
        setPortfolios(payload.portfolios);
      }
      if (payload?.importLogs) {
        setImportLogs(payload.importLogs);
      }
      setConfirmUndoId(null);
      setCommitResult(null);
      setUndoFeedback("Import undone cleanly. All records from that batch were removed.");
      router.refresh();
    } catch {
      setErrorMessage("Network error while undoing import.");
    } finally {
      setUndoingId(null);
    }
  }

  const validRowCount = preview
    ? preview.placeholderCount + preview.transactionCount
    : 0;

  const portfolioQueryParam =
    exportPortfolioId !== "all"
      ? `&portfolioId=${encodeURIComponent(exportPortfolioId)}`
      : "";

  return (
    <div className="space-y-6">
      {/* Error banner */}
      {errorMessage && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-[12px] border border-loss/35 bg-loss/8 px-4 py-3.5 text-[14px] text-loss"
        >
          <AlertCircle className="mt-0.5 h-4.5 w-4.5 shrink-0" />
          <div className="min-w-0 flex-1 leading-relaxed">{errorMessage}</div>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            aria-label="Dismiss error"
            className="rounded-[10px] p-1 text-loss/80 transition-colors hover:bg-loss/10 hover:text-loss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Undo feedback banner */}
      {undoFeedback && (
        <div
          role="status"
          className="flex items-center justify-between gap-3 rounded-[12px] border border-accent/30 bg-accent/10 px-4 py-3 text-[14px] text-accent"
        >
          <div className="flex items-center gap-2.5">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>{undoFeedback}</span>
          </div>
          <button
            type="button"
            onClick={() => setUndoFeedback(null)}
            aria-label="Dismiss message"
            className="rounded-[10px] p-1 text-accent/80 transition-colors hover:bg-accent/15 hover:text-accent"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Commit success + non-blocking symbol resolution report */}
      {commitResult && (
        <Card className="p-5 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-accent/12 text-accent">
                <CheckCircle2 className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-[17px] font-semibold tracking-[-0.02em] text-ink">
                  Imported {commitResult.filename}
                </h2>
                <p className="mt-1 text-[14px] text-ink-2 num">
                  {commitResult.rowCounts.transactionsImported} transactions saved
                  across {commitResult.rowCounts.instrumentsTracked} newly tracked
                  symbol links
                  {commitResult.rowCounts.portfoliosCreated > 0
                    ? ` (${commitResult.rowCounts.portfoliosCreated} new portfolios)`
                    : ""}
                  {commitResult.rowCounts.skippedDuplicates > 0
                    ? ` · ${commitResult.rowCounts.skippedDuplicates} duplicates skipped`
                    : ""}
                  .
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <ButtonLink href="/transactions" variant="primary">
                View Transactions
              </ButtonLink>
              <Button
                variant="ghost"
                onClick={() => setCommitResult(null)}
              >
                Dismiss
              </Button>
            </div>
          </div>

          {commitResult.unresolvedSymbols.length > 0 && (
            <div className="mt-4 rounded-[12px] border border-line bg-field-bg p-4">
              <p className="text-[12px] font-medium text-ink-2">
                Symbol Resolution Notes ({commitResult.unresolvedSymbols.length})
              </p>
              <p className="mt-1 text-[13px] text-ink-2">
                These symbols were imported losslessly so CSV exports stay intact,
                and will show a clear &ldquo;price unavailable&rdquo; state until
                configured:
              </p>
              <ul className="mt-3 divide-y divide-line text-[13px]">
                {commitResult.unresolvedSymbols.map((item) => (
                  <li
                    key={item.symbol}
                    className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0 sm:flex-row sm:items-baseline sm:justify-between"
                  >
                    <div className="font-medium text-ink">
                      <span className="font-mono">{item.symbol}</span>{" "}
                      <span className="text-ink-3">
                        ({item.portfolioNames.join(", ")})
                      </span>
                    </div>
                    <span className="text-ink-2">{item.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}

      {/* 1. Upload Dropzone Card (shown when not currently previewing) */}
      {!preview && (
        <Card className="p-5 sm:p-6">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-[17px] font-semibold tracking-[-0.02em] text-ink">
                Import Portfolio CSV
              </h2>
              <p className="mt-0.5 text-[14px] text-ink-2">
                Supports the 19-column Microsoft Start export (
                <code className="rounded bg-field-bg px-1.5 py-0.5 font-mono text-[12px] text-ink">
                  MSP-Portfolios-*.csv
                </code>
                ) or Kestrel&rsquo;s plain spreadsheet template.
              </p>
            </div>
            <div className="mt-3 sm:mt-0">
              <a
                href="/api/import-export/export?format=template"
                className={getButtonClasses("secondary", "w-full sm:w-auto")}
              >
                <FileSpreadsheet className="h-4 w-4" />
                Blank CSV Template
              </a>
            </div>
          </div>

          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`mt-5 flex flex-col items-center justify-center rounded-[12px] border border-dashed px-5 py-9 text-center transition-colors duration-150 ${
              isDragging
                ? "border-accent bg-accent/10"
                : "border-line bg-field-bg hover:bg-surface-2"
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleFileChange}
              className="sr-only"
              aria-label="Choose CSV file to preview"
            />
            <div className="flex h-12 w-12 items-center justify-center rounded-[12px] border border-line bg-surface">
              <FileUp className="h-5 w-5 text-accent" />
            </div>
            <p className="mt-3.5 text-[15px] font-medium text-ink">
              {isPreviewLoading
                ? "Inspecting CSV rows and verifying FIFO ledger…"
                : "Drop your CSV file here, or choose a file to preview"}
            </p>
            <p className="mt-1 max-w-md text-[13px] text-ink-2">
              Nothing is saved immediately. You will review portfolios, row
              counts, duplicates, and any validation warnings first.
            </p>
            <div className="mt-5">
              <Button
                variant="primary"
                disabled={isPreviewLoading}
                onClick={() => fileInputRef.current?.click()}
              >
                {isPreviewLoading ? "Analysing…" : "Choose CSV File"}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* 2. Interactive Preview Step (nothing written until user confirms) */}
      {preview && (
        <Card className="overflow-hidden">
          <div className="border-b border-line px-5 py-4 sm:px-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-[18px] font-semibold tracking-[-0.02em] text-ink">
                    Preview: {selectedFilename}
                  </h2>
                  <span className="inline-flex items-center rounded-[6px] border border-line bg-field-bg px-2.5 py-0.5 text-[12px] font-medium text-ink-2">
                    {preview.format === "msp"
                      ? "Microsoft Start 19-Column"
                      : "Plain Template"}
                  </span>
                </div>
                <p className="mt-0.5 text-[13px] text-ink-2">
                  Review your import summary below before saving to the ledger.
                </p>
              </div>
              <div className="flex items-center gap-2 self-start sm:self-center">
                <Button
                  variant="ghost"
                  onClick={clearPreview}
                  disabled={isCommitting}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </div>

          <div className="space-y-6 p-5 sm:p-6">
            {/* Summary metrics grid */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-[12px] border border-line bg-field-bg p-3.5">
                <p className="text-[12px] font-medium text-ink-2">Portfolios</p>
                <p className="mt-1 text-[22px] font-semibold tracking-[-0.02em] text-ink num">
                  {preview.portfolios.length}
                </p>
              </div>
              <div className="rounded-[12px] border border-line bg-field-bg p-3.5">
                <p className="text-[12px] font-medium text-ink-2">
                  Unique Symbols
                </p>
                <p className="mt-1 text-[22px] font-semibold tracking-[-0.02em] text-ink num">
                  {preview.detectedSymbols.length}
                </p>
              </div>
              <div className="rounded-[12px] border border-line bg-field-bg p-3.5">
                <p className="text-[12px] font-medium text-ink-2">
                  Valid Transactions
                </p>
                <p className="mt-1 text-[22px] font-semibold tracking-[-0.02em] text-ink num">
                  {preview.transactionCount}
                </p>
              </div>
              <div className="rounded-[12px] border border-line bg-field-bg p-3.5">
                <p className="text-[12px] font-medium text-ink-2">
                  Symbol Placeholders
                </p>
                <p className="mt-1 text-[22px] font-semibold tracking-[-0.02em] text-ink num">
                  {preview.placeholderCount}
                </p>
              </div>
            </div>

            {/* Counts by transaction type */}
            <div className="flex flex-wrap items-center gap-2 text-[13px] num">
              <span className="font-medium text-ink-2">By type:</span>
              <span className="rounded-[6px] border border-line bg-field-bg px-2.5 py-1 text-ink">
                Buy: <strong>{preview.typeCounts.Buy}</strong>
              </span>
              <span className="rounded-[6px] border border-line bg-field-bg px-2.5 py-1 text-ink">
                Sell: <strong>{preview.typeCounts.Sell}</strong>
              </span>
              <span className="rounded-[6px] border border-line bg-field-bg px-2.5 py-1 text-ink">
                Sell All: <strong>{preview.typeCounts["Sell All"]}</strong>
              </span>
              <span className="rounded-[6px] border border-line bg-field-bg px-2.5 py-1 text-ink">
                Dividend: <strong>{preview.typeCounts.Dividend}</strong>
              </span>
            </div>

            {/* Duplicate handling control */}
            <div className="rounded-[12px] border border-line bg-surface-2 p-4">
              <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                <span className="text-[13px] font-semibold text-ink">
                  Duplicate handling
                </span>
                <span className="text-[12px] font-medium text-ink-2 num">
                  {preview.duplicateTransactionCount > 0
                    ? `${preview.duplicateTransactionCount} matching transactions already in database`
                    : "No existing duplicates detected"}
                </span>
              </div>
              <SegmentedControl
                ariaLabel="Duplicate import behaviour"
                options={DUPLICATE_MODE_OPTIONS}
                value={duplicateMode}
                onChange={setDuplicateMode}
                layoutId="csv-duplicate-mode"
                fullWidth
              />
              <p className="mt-2.5 text-[12.5px] leading-relaxed text-ink-2">
                {DUPLICATE_MODE_DESCRIPTIONS[duplicateMode]}
              </p>
            </div>

            {/* Portfolios breakdown (mobile cards + desktop table) */}
            <div>
              <h3 className="mb-2.5 text-[14px] font-semibold text-ink">
                Portfolios in File ({preview.portfolios.length})
              </h3>

              {/* Mobile inset list */}
              <div className="divide-y divide-line rounded-[12px] border border-line bg-field-bg sm:hidden">
                {preview.portfolios.map((p) => (
                  <div key={p.name} className="space-y-1.5 p-3.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-ink">{p.name}</span>
                      <span className="rounded-[6px] border border-line bg-surface px-2.5 py-0.5 text-[11px] font-medium capitalize text-ink-2">
                        {p.inferredType} · {p.defaultCurrency}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12.5px] text-ink-2 num">
                      <span>{p.symbolCount} symbols</span>
                      <span>· {p.transactionCount} transactions</span>
                      {p.duplicateTransactionCount > 0 && (
                        <span className="text-accent">
                          · {p.duplicateTransactionCount} existing
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop table */}
              <div className="hidden overflow-hidden rounded-[12px] border border-line sm:block">
                <table className="w-full border-collapse text-left text-[13.5px]">
                  <thead>
                    <tr className="border-b border-line bg-field-bg text-[12px] font-medium text-ink-2">
                      <th className="px-4 py-2.5">Portfolio</th>
                      <th className="px-4 py-2.5">Kind</th>
                      <th className="px-4 py-2.5">Currency</th>
                      <th className="px-4 py-2.5 text-right">Symbols</th>
                      <th className="px-4 py-2.5 text-right">Transactions</th>
                      <th className="px-4 py-2.5 text-right">Duplicates</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {preview.portfolios.map((p) => (
                      <tr key={p.name} className="bg-surface">
                        <td className="px-4 py-2.5 font-medium text-ink">
                          {p.name}
                          {p.alreadyExists && (
                            <span className="ml-2 text-[11.5px] font-normal text-ink-2">
                              (existing)
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 capitalize text-ink-2">
                          {p.inferredType}
                        </td>
                        <td className="px-4 py-2.5 text-[12.5px] text-ink-2">
                          {p.defaultCurrency}
                        </td>
                        <td className="px-4 py-2.5 text-right text-ink num">
                          {p.symbolCount}
                        </td>
                        <td className="px-4 py-2.5 text-right text-ink num">
                          {p.transactionCount}
                        </td>
                        <td className="px-4 py-2.5 text-right text-ink-2 num">
                          {p.duplicateTransactionCount}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Rejected rows callout + Download Rejected Rows CSV */}
            {preview.rejectedRows.length > 0 && (
              <div className="rounded-[12px] border border-line bg-field-bg p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-start gap-2.5">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                    <div>
                      <h3 className="text-[14px] font-semibold text-ink num">
                        {preview.rejectedRows.length} invalid{" "}
                        {preview.rejectedRows.length === 1 ? "row" : "rows"}{" "}
                        will be skipped
                      </h3>
                      <p className="mt-0.5 text-[12.5px] text-ink-2">
                        Valid rows can still be imported now. Download the
                        rejected rows CSV to fix and re-upload them later.
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="secondary"
                    onClick={handleDownloadRejectedCsv}
                    className="shrink-0"
                  >
                    <ArrowDownToLine className="h-4 w-4" />
                    Download Rejected CSV
                  </Button>
                </div>

                <ul className="mt-3 max-h-52 divide-y divide-line overflow-y-auto rounded-[10px] border border-line bg-surface px-3.5 py-1 text-[12.5px]">
                  {preview.rejectedRows.map((err) => (
                    <li key={err.lineNumber} className="py-2">
                      <span className="font-semibold text-ink num">
                        Line {err.lineNumber}
                      </span>
                      {err.symbol ? (
                        <span className="ml-2 font-mono font-medium text-ink">
                          {err.symbol}
                        </span>
                      ) : null}
                      {err.portfolio ? (
                        <span className="ml-1.5 text-ink-2">
                          ({err.portfolio})
                        </span>
                      ) : null}
                      <span className="ml-2 text-ink-2">— {err.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Non-blocking warnings */}
            {preview.warnings.length > 0 && (
              <div className="rounded-[12px] border border-line bg-field-bg p-4">
                <div className="flex items-center gap-2 text-[13.5px] font-semibold text-ink">
                  <TriangleAlert className="h-4 w-4 text-accent" />
                  <span className="num">
                    Data Notes ({preview.warnings.length})
                  </span>
                </div>
                <ul className="mt-2.5 max-h-44 space-y-1.5 overflow-y-auto text-[12.5px] leading-relaxed text-ink-2">
                  {preview.warnings.map((w, idx) => (
                    <li key={`${w.kind}-${idx}`}>• {w.message}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Sample rows */}
            {preview.sampleRows.length > 0 && (
              <div>
                <h3 className="mb-2.5 text-[14px] font-semibold text-ink num">
                  Sample Rows (first {preview.sampleRows.length} of{" "}
                  {validRowCount} valid rows)
                </h3>

                {/* Mobile sample list */}
                <div className="divide-y divide-line rounded-[12px] border border-line bg-field-bg sm:hidden">
                  {preview.sampleRows.map((row) => (
                    <div key={row.lineNumber} className="space-y-1 p-3 text-[12.5px]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono font-semibold text-ink">
                          {row.symbol}
                        </span>
                        <span className="rounded-[6px] border border-line bg-surface px-2 py-0.5 text-[11px] font-medium text-ink-2">
                          {row.kind}
                        </span>
                      </div>
                      <div className="flex justify-between text-ink-2 num">
                        <span>{row.portfolio}</span>
                        <span>
                          {row.kind === "Placeholder"
                            ? row.currency
                            : `${row.quantity} @ ${row.price} ${row.currency}`}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Desktop sample table */}
                <div className="hidden overflow-x-auto rounded-[12px] border border-line sm:block">
                  <table className="w-full border-collapse text-left text-[13px]">
                    <thead>
                      <tr className="border-b border-line bg-field-bg text-[12px] font-medium text-ink-2">
                        <th className="px-3.5 py-2">Line</th>
                        <th className="px-3.5 py-2">Portfolio</th>
                        <th className="px-3.5 py-2">Symbol</th>
                        <th className="px-3.5 py-2">Type</th>
                        <th className="px-3.5 py-2 text-right">Shares / Amt</th>
                        <th className="px-3.5 py-2 text-right">Price</th>
                        <th className="px-3.5 py-2">Date (SGT)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line bg-surface num">
                      {preview.sampleRows.map((row) => (
                        <tr key={row.lineNumber}>
                          <td className="px-3.5 py-2 text-[12px] text-ink-2">
                            {row.lineNumber}
                          </td>
                          <td className="px-3.5 py-2 text-ink-2">
                            {row.portfolio}
                          </td>
                          <td className="px-3.5 py-2 font-mono font-medium text-ink">
                            {row.symbol}
                          </td>
                          <td className="px-3.5 py-2 text-ink-2">{row.kind}</td>
                          <td className="px-3.5 py-2 text-right text-ink">
                            {row.quantity}
                          </td>
                          <td className="px-3.5 py-2 text-right text-ink">
                            {row.price === "—"
                              ? "—"
                              : `${row.price} ${row.currency}`}
                          </td>
                          <td className="px-3.5 py-2 font-mono text-[12px] text-ink-2">
                            {row.date}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Action footer */}
            <div className="flex flex-col-reverse gap-2.5 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-end">
              <Button
                variant="secondary"
                onClick={clearPreview}
                disabled={isCommitting}
                className="w-full sm:w-auto"
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={isCommitting || validRowCount === 0}
                onClick={handleCommitImport}
                className="w-full sm:w-auto"
              >
                {isCommitting
                  ? "Importing…"
                  : `Import ${validRowCount} Valid ${validRowCount === 1 ? "Row" : "Rows"}`}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* 3. Export & One-Click Backup Card */}
      <Card className="p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-[17px] font-semibold tracking-[-0.02em] text-ink">
              Export &amp; One-Click Backup
            </h2>
            <p className="mt-0.5 text-[14px] text-ink-2">
              Download your portfolios in lossless Microsoft Start CSV format, a
              clean spreadsheet CSV, or a full JSON backup.
            </p>
          </div>

          <div className="w-full sm:w-64">
            <label
              htmlFor="export-portfolio-select"
              className="mb-1.5 flex h-5 items-center text-[13px] font-medium text-ink-2"
            >
              Scope for CSV exports
            </label>
            <div className="relative">
              <select
                id="export-portfolio-select"
                value={exportPortfolioId}
                onChange={(e) => setExportPortfolioId(e.target.value)}
                className="field-input appearance-none pr-9"
              >
                <option value="all">All portfolios</option>
                {portfolios.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.type === "watchlist" ? "Watchlist" : p.defaultCurrency})
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-2" />
            </div>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-3">
          {/* Original MSP Format */}
          <div className="flex flex-col justify-between rounded-[12px] border border-line bg-field-bg p-4">
            <div>
              <div className="flex items-center gap-2 text-[15px] font-semibold text-ink">
                <FileSpreadsheet className="h-4 w-4 text-accent" />
                <span>Original Format (MSP CSV)</span>
              </div>
              <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
                Exact 19-column Microsoft Start export with placeholder rows,{" "}
                <code className="font-mono text-[12px]">GMT+0800</code> dates,
                and original commissions.
              </p>
            </div>
            <div className="mt-4">
              <a
                href={`/api/import-export/export?format=msp${portfolioQueryParam}`}
                className={getButtonClasses("secondary", "w-full")}
              >
                <ArrowDownToLine className="h-4 w-4" />
                Export MSP CSV
              </a>
            </div>
          </div>

          {/* One-Click Full Backup */}
          <div className="flex flex-col justify-between rounded-[12px] border border-line bg-field-bg p-4">
            <div>
              <div className="flex items-center gap-2 text-[15px] font-semibold text-ink">
                <DatabaseBackup className="h-4 w-4 text-accent" />
                <span>One-Click Full Backup</span>
              </div>
              <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
                Complete JSON snapshot of all portfolios, watchlists, ledger
                rows, stock splits, settings, and embedded MSP CSV.
              </p>
            </div>
            <div className="mt-4">
              <a
                href="/api/import-export/export?format=backup"
                className={getButtonClasses("secondary", "w-full")}
              >
                <ArrowDownToLine className="h-4 w-4" />
                Download Backup (.json)
              </a>
            </div>
          </div>

          {/* Clean Modern CSV */}
          <div className="flex flex-col justify-between rounded-[12px] border border-line bg-field-bg p-4">
            <div>
              <div className="flex items-center gap-2 text-[15px] font-semibold text-ink">
                <ArrowDownToLine className="h-4 w-4 text-accent" />
                <span>Clean Spreadsheet CSV</span>
              </div>
              <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
                Modern ISO-8601 UTC + Singapore timestamps and locked SGD cost
                snapshots, hardened against spreadsheet formula injection.
              </p>
            </div>
            <div className="mt-4">
              <a
                href={`/api/import-export/export?format=clean${portfolioQueryParam}`}
                className={getButtonClasses("secondary", "w-full")}
              >
                <ArrowDownToLine className="h-4 w-4" />
                Export Clean CSV
              </a>
            </div>
          </div>
        </div>
      </Card>

      {/* 4. Import History & Undo Card */}
      <Card className="p-5 sm:p-6">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-ink-2" />
          <h2 className="text-[17px] font-semibold tracking-[-0.02em] text-ink">
            Import History
          </h2>
        </div>
        <p className="mt-0.5 text-[14px] text-ink-2">
          Every CSV import is logged with an audit ID so you can roll back a
          batch in one click.
        </p>

        {importLogs.length === 0 ? (
          <div className="mt-4 rounded-[12px] border border-line bg-field-bg px-4 py-6 text-center text-[13.5px] text-ink-2">
            No CSV imports have been run yet.
          </div>
        ) : (
          <div className="mt-4 divide-y divide-line rounded-[12px] border border-line bg-field-bg">
            {importLogs.map((log) => {
              const isUndone = log.status === "undone";
              const isConfirming = confirmUndoId === log.id;
              const isBusy = undoingId === log.id;
              const txCount = log.rowCounts.transactionsImported ?? 0;
              const skippedCount = log.rowCounts.skippedDuplicates ?? 0;

              return (
                <div
                  key={log.id}
                  className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-semibold text-ink">
                        {log.filename}
                      </span>
                      <span
                        className={`inline-flex items-center rounded-[6px] px-2 py-0.5 text-[11.5px] font-medium ${
                          isUndone
                            ? "border border-line bg-surface text-ink-2"
                            : "bg-accent/12 text-accent"
                        }`}
                      >
                        {isUndone ? "Undone" : "Committed"}
                      </span>
                    </div>
                    <p className="text-[12.5px] text-ink-2 num">
                      <span className="font-mono">
                        {formatSgtTimestamp(log.createdAt)} SGT
                      </span>{" "}
                      · {txCount} transactions imported
                      {skippedCount > 0 ? ` · ${skippedCount} skipped` : ""}
                      {isUndone && log.undoneAt ? (
                        <>
                          {" "}
                          · Undone{" "}
                          <span className="font-mono">
                            {formatSgtTimestamp(log.undoneAt)}
                          </span>
                        </>
                      ) : (
                        ""
                      )}
                    </p>
                  </div>

                  {!isUndone && (
                    <div className="flex items-center gap-2 self-start sm:self-center">
                      {isConfirming ? (
                        <>
                          <Button
                            variant="ghost"
                            disabled={isBusy}
                            onClick={() => setConfirmUndoId(null)}
                          >
                            Keep
                          </Button>
                          <Button
                            variant="secondary"
                            disabled={isBusy}
                            onClick={() => void handleUndoImport(log.id)}
                          >
                            {isBusy ? "Undoing…" : "Confirm Undo"}
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="secondary"
                          onClick={() => setConfirmUndoId(log.id)}
                        >
                          <RotateCcw className="h-4 w-4" />
                          Undo Import
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

