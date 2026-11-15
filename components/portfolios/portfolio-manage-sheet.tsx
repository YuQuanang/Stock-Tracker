"use client";

import {
  AlertCircle,
  Check,
  ChevronDown,
  FolderPlus,
  Loader2,
  Pencil,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Portfolio } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";

interface PortfolioRenameListProps {
  portfolios: Portfolio[];
  initialEditingPortfolioId?: string | null;
  showTypeBadge?: boolean;
  onRenamed: (updated: Portfolio) => void;
  emptyMessage?: string;
}

/**
 * Shared inline-rename list for portfolios (and watchlists in Settings).
 * Calls `PATCH /api/portfolios/[id]` and surfaces conflict/validation errors cleanly.
 */
export function PortfolioRenameList({
  portfolios,
  initialEditingPortfolioId = null,
  showTypeBadge = false,
  onRenamed,
  emptyMessage = "No portfolios created yet.",
}: PortfolioRenameListProps) {
  const [editingId, setEditingId] = useState<string | null>(() => {
    if (
      initialEditingPortfolioId &&
      portfolios.some((p) => p.id === initialEditingPortfolioId)
    ) {
      return initialEditingPortfolioId;
    }
    return null;
  });
  const [draftName, setDraftName] = useState<string>(() => {
    const initial = portfolios.find((p) => p.id === initialEditingPortfolioId);
    return initial?.name ?? "";
  });
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) {
        clearTimeout(savedTimerRef.current);
      }
    };
  }, []);

  function startEditing(item: Portfolio): void {
    setEditingId(item.id);
    setDraftName(item.name);
    setError(null);
  }

  function cancelEditing(): void {
    setEditingId(null);
    setDraftName("");
    setError(null);
  }

  async function handleSave(event: FormEvent, item: Portfolio): Promise<void> {
    event.preventDefault();
    const trimmed = draftName.trim();
    if (!trimmed) {
      setError("Portfolio name cannot be empty.");
      return;
    }

    if (trimmed === item.name) {
      cancelEditing();
      return;
    }

    setError(null);
    setIsSaving(true);
    try {
      const response = await fetch(`/api/portfolios/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });

      const body = (await response.json().catch(() => null)) as {
        portfolio?: Portfolio;
        error?: string;
      } | null;

      if (!response.ok || !body?.portfolio) {
        setError(body?.error ?? "Unable to rename portfolio.");
        return;
      }

      setEditingId(null);
      setDraftName("");
      setSavedId(item.id);
      if (savedTimerRef.current) {
        clearTimeout(savedTimerRef.current);
      }
      savedTimerRef.current = setTimeout(() => {
        setSavedId((curr) => (curr === item.id ? null : curr));
      }, 2000);

      onRenamed(body.portfolio);
    } catch {
      setError("Network error while saving portfolio name.");
    } finally {
      setIsSaving(false);
    }
  }

  if (portfolios.length === 0) {
    return (
      <p className="rounded-[12px] border border-dashed border-line px-4 py-4 text-[13px] text-ink-2">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="divide-y divide-line overflow-hidden rounded-[12px] border border-line bg-surface-2/40">
      {portfolios.map((item) => {
        const isEditing = editingId === item.id;
        const justSaved = savedId === item.id;

        if (isEditing) {
          return (
            <form
              key={item.id}
              onSubmit={(event) => void handleSave(event, item)}
              className="space-y-2.5 bg-surface-2 px-3.5 py-3"
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  type="text"
                  autoFocus
                  maxLength={80}
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      cancelEditing();
                    }
                  }}
                  aria-label={`New name for ${item.name}`}
                  className="field-input h-9 flex-1 bg-field-bg text-[14px]"
                  disabled={isSaving}
                />
                <div className="flex items-center justify-end gap-1.5">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={cancelEditing}
                    disabled={isSaving}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={isSaving || !draftName.trim()}
                  >
                    {isSaving ? (
                      <>
                        <Loader2
                          size={14}
                          className="animate-spin"
                          aria-hidden="true"
                        />
                        <span>Saving…</span>
                      </>
                    ) : (
                      <span>Save</span>
                    )}
                  </Button>
                </div>
              </div>

              {error && (
                <p
                  role="alert"
                  className="flex items-center gap-1.5 text-[12.5px] text-loss"
                >
                  <AlertCircle size={14} className="shrink-0" aria-hidden="true" />
                  <span>{error}</span>
                </p>
              )}
            </form>
          );
        }

        return (
          <div
            key={item.id}
            className="flex items-center justify-between gap-3 px-3.5 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-[14px] font-medium text-ink">
                  {item.name}
                </span>
                <span className="rounded-[6px] border border-line bg-surface px-1.5 py-0.5 text-[11px] font-medium text-ink-2">
                  {item.defaultCurrency}
                </span>
                {showTypeBadge && (
                  <span className="rounded-[6px] bg-surface px-1.5 py-0.5 text-[11px] text-ink-3">
                    {item.type === "watchlist" ? "Watchlist" : "Holdings"}
                  </span>
                )}
                {justSaved && (
                  <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-gain">
                    <Check size={12} aria-hidden="true" />
                    Saved
                  </span>
                )}
              </div>
            </div>

            <Button
              variant="secondary"
              size="sm"
              onClick={() => startEditing(item)}
              aria-label={`Rename portfolio ${item.name}`}
              className="h-8! px-2.5! text-[12.5px]!"
            >
              <Pencil size={13} strokeWidth={1.9} aria-hidden="true" />
              <span>Rename</span>
            </Button>
          </div>
        );
      })}
    </div>
  );
}

interface PortfolioManageSheetProps {
  isOpen: boolean;
  portfolios: Portfolio[];
  initialSelectedPortfolioId?: string | null;
  onClose: () => void;
  onChanged: () => void;
  onCreated?: (newPortfolioId: string) => void;
}

export function PortfolioManageSheet({
  isOpen,
  portfolios,
  initialSelectedPortfolioId = null,
  onClose,
  onChanged,
  onCreated,
}: PortfolioManageSheetProps) {
  if (!isOpen) {
    return null;
  }

  return (
    <Sheet
      isOpen={isOpen}
      onClose={onClose}
      maxWidthClass="sm:max-w-[480px]"
      title="Manage portfolios"
      description="Rename an existing holdings portfolio or create a new independent FIFO ledger."
    >
      <PortfolioManageForm
        key={`${initialSelectedPortfolioId ?? "all"}-${portfolios.length}`}
        portfolios={portfolios}
        initialSelectedPortfolioId={initialSelectedPortfolioId}
        onClose={onClose}
        onChanged={onChanged}
        onCreated={onCreated}
      />
    </Sheet>
  );
}

function PortfolioManageForm({
  portfolios,
  initialSelectedPortfolioId,
  onClose,
  onChanged,
  onCreated,
}: Omit<PortfolioManageSheetProps, "isOpen">) {
  const holdingsPortfolios = portfolios.filter((p) => p.type === "holdings");

  const [newName, setNewName] = useState("");
  const [newCurrency, setNewCurrency] = useState<"USD" | "SGD">("USD");
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function handleCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) {
      setCreateError("Portfolio name cannot be empty.");
      return;
    }

    setCreateError(null);
    setIsCreating(true);
    try {
      const response = await fetch("/api/portfolios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmed,
          type: "holdings",
          defaultCurrency: newCurrency,
        }),
      });

      const body = (await response.json().catch(() => null)) as {
        portfolio?: Portfolio;
        error?: string;
      } | null;

      if (!response.ok || !body?.portfolio) {
        setCreateError(body?.error ?? "Could not create portfolio.");
        return;
      }

      setNewName("");
      onCreated?.(body.portfolio.id);
      onChanged();
      onClose();
    } catch {
      setCreateError("Network error while creating portfolio.");
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2.5">
        <div className="flex items-center justify-between">
          <h3 className="text-[13px] font-medium text-ink-2">
            Existing portfolios ({holdingsPortfolios.length})
          </h3>
        </div>
        <PortfolioRenameList
          portfolios={holdingsPortfolios}
          initialEditingPortfolioId={
            initialSelectedPortfolioId && initialSelectedPortfolioId !== "all"
              ? initialSelectedPortfolioId
              : null
          }
          onRenamed={() => onChanged()}
          emptyMessage="No holdings portfolios yet. Create your first portfolio below."
        />
      </div>

      <form
        onSubmit={(event) => void handleCreate(event)}
        className="space-y-3.5 border-t border-line pt-5"
      >
        <div className="flex items-center gap-2">
          <FolderPlus className="h-4 w-4 text-accent" aria-hidden="true" />
          <h3 className="text-[14px] font-semibold text-ink">
            Create new portfolio
          </h3>
        </div>

        <div>
          <label
            htmlFor="manage-new-portfolio-name"
            className="mb-1.5 block h-5 text-[13px] font-medium leading-5 text-ink-2"
          >
            Portfolio name
          </label>
          <input
            id="manage-new-portfolio-name"
            type="text"
            maxLength={80}
            placeholder="US Stocks, SG Stocks, or Current"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            className="field-input"
            disabled={isCreating}
          />
        </div>

        <div>
          <label
            htmlFor="manage-new-portfolio-currency"
            className="mb-1.5 block h-5 text-[13px] font-medium leading-5 text-ink-2"
          >
            Default currency
          </label>
          <div className="relative">
            <select
              id="manage-new-portfolio-currency"
              value={newCurrency}
              onChange={(event) =>
                setNewCurrency(event.target.value === "SGD" ? "SGD" : "USD")
              }
              className="field-input appearance-none pr-9"
              disabled={isCreating}
            >
              <option value="USD">USD — US Dollar</option>
              <option value="SGD">SGD — Singapore Dollar</option>
            </select>
            <ChevronDown
              size={16}
              strokeWidth={2}
              aria-hidden="true"
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-2"
            />
          </div>
        </div>

        {createError && (
          <p
            role="alert"
            className="flex items-center gap-1.5 text-[13px] text-loss"
          >
            <AlertCircle size={14} className="shrink-0" aria-hidden="true" />
            <span>{createError}</span>
          </p>
        )}

        <div className="grid grid-cols-2 gap-2.5 pt-1 sm:flex sm:justify-end">
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            className="w-full sm:w-auto"
          >
            Done
          </Button>
          <Button
            type="submit"
            disabled={isCreating || !newName.trim()}
            className="w-full sm:w-auto"
          >
            {isCreating ? (
              <>
                <Loader2
                  size={15}
                  className="animate-spin"
                  aria-hidden="true"
                />
                <span>Creating…</span>
              </>
            ) : (
              <span>Create Portfolio</span>
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}

