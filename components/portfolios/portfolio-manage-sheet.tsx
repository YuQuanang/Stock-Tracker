"use client";

import {
  AlertCircle,
  Check,
  ChevronDown,
  FolderPlus,
  Loader2,
  Pencil,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Portfolio } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";

interface PortfolioRenameListProps {
  portfolios: Portfolio[];
  initialEditingPortfolioId?: string | null;
  defaultPortfolioId?: string;
  showTypeBadge?: boolean;
  allowDelete?: boolean;
  onRenamed: (updated: Portfolio) => void;
  onDeleted?: (deleted: Portfolio) => void;
  emptyMessage?: string;
}

/**
 * Shared inline-rename & delete list for portfolios (and watchlists in Settings).
 * Calls `PATCH /api/portfolios/[id]` and `DELETE /api/portfolios/[id]`.
 */
export function PortfolioRenameList({
  portfolios,
  initialEditingPortfolioId = null,
  defaultPortfolioId,
  showTypeBadge = false,
  allowDelete = true,
  onRenamed,
  onDeleted,
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
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
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
    setConfirmDeleteId(null);
    setEditingId(item.id);
    setDraftName(item.name);
    setError(null);
  }

  function cancelEditing(): void {
    setEditingId(null);
    setDraftName("");
    setError(null);
  }

  function startDeleteConfirm(item: Portfolio): void {
    setEditingId(null);
    setDraftName("");
    setConfirmDeleteId(item.id);
    setError(null);
  }

  function cancelDeleteConfirm(): void {
    setConfirmDeleteId(null);
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

  async function handleConfirmDelete(item: Portfolio): Promise<void> {
    setError(null);
    setIsDeleting(true);
    try {
      const response = await fetch(`/api/portfolios/${item.id}`, {
        method: "DELETE",
      });

      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;

      if (!response.ok) {
        setError(body?.error ?? "Unable to delete portfolio.");
        return;
      }

      setConfirmDeleteId(null);
      onDeleted?.(item);
    } catch {
      setError("Network error while deleting portfolio.");
    } finally {
      setIsDeleting(false);
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
        const isConfirmingDelete = confirmDeleteId === item.id;
        const justSaved = savedId === item.id;
        const isDefault =
          item.type === "holdings" && defaultPortfolioId === item.id;

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
                        <span>Saving...</span>
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

        if (isConfirmingDelete) {
          return (
            <div
              key={item.id}
              className="space-y-3 bg-loss/8 px-3.5 py-3"
            >
              <div className="space-y-1">
                <p className="text-[13.5px] font-semibold text-ink">
                  Delete &ldquo;{item.name}&rdquo;?
                </p>
                <p className="text-[12.5px] leading-snug text-ink-2">
                  {item.type === "watchlist"
                    ? "This permanently deletes this watchlist and all tracked symbols in it."
                    : "This permanently deletes this portfolio along with all of its transactions and holdings. This cannot be undone."}
                </p>
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

              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={cancelDeleteConfirm}
                  disabled={isDeleting}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  onClick={() => void handleConfirmDelete(item)}
                  disabled={isDeleting}
                >
                  {isDeleting ? (
                    <>
                      <Loader2
                        size={14}
                        className="animate-spin"
                        aria-hidden="true"
                      />
                      <span>Deleting...</span>
                    </>
                  ) : (
                    <>
                      <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
                      <span>Delete</span>
                    </>
                  )}
                </Button>
              </div>
            </div>
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
                {isDefault && (
                  <span className="rounded-[6px] bg-accent/14 px-1.5 py-0.5 text-[11px] font-medium text-accent">
                    Default
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

            <div className="flex shrink-0 items-center gap-1.5">
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
              {allowDelete && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => startDeleteConfirm(item)}
                  aria-label={`Delete portfolio ${item.name}`}
                  className="h-8! w-8! px-0! text-ink-2 hover:bg-loss/12 hover:text-loss"
                >
                  <Trash2 size={14} strokeWidth={1.9} aria-hidden="true" />
                </Button>
              )}
            </div>
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
  defaultPortfolioId?: string;
  onClose: () => void;
  onChanged: () => void;
  onCreated?: (newPortfolioId: string) => void;
  onDeleted?: (deleted: Portfolio) => void;
  onDefaultChanged?: (nextDefaultPortfolioId: string) => void;
}

export function PortfolioManageSheet({
  isOpen,
  portfolios,
  initialSelectedPortfolioId = null,
  defaultPortfolioId = "all",
  onClose,
  onChanged,
  onCreated,
  onDeleted,
  onDefaultChanged,
}: PortfolioManageSheetProps) {
  if (!isOpen) {
    return null;
  }

  return (
    <Sheet
      isOpen={isOpen}
      onClose={onClose}
      maxWidthClass="sm:max-w-[500px]"
      title="Manage portfolios"
      description="Choose your default portfolio view, rename or delete portfolios, or create a new independent FIFO ledger."
    >
      <PortfolioManageForm
        key={`${initialSelectedPortfolioId ?? "all"}-${defaultPortfolioId}-${portfolios.map((p) => p.id).join(",")}`}
        portfolios={portfolios}
        initialSelectedPortfolioId={initialSelectedPortfolioId}
        defaultPortfolioId={defaultPortfolioId}
        onClose={onClose}
        onChanged={onChanged}
        onCreated={onCreated}
        onDeleted={onDeleted}
        onDefaultChanged={onDefaultChanged}
      />
    </Sheet>
  );
}

function PortfolioManageForm({
  portfolios,
  defaultPortfolioId = "all",
  onClose,
  onChanged,
  onCreated,
  onDeleted,
  onDefaultChanged,
}: Omit<PortfolioManageSheetProps, "isOpen">) {
  const holdingsPortfolios = portfolios.filter((p) => p.type === "holdings");
  const resolvedDefault =
    defaultPortfolioId !== "all" &&
    holdingsPortfolios.some((p) => p.id === defaultPortfolioId)
      ? defaultPortfolioId
      : "all";

  const [activeDefaultId, setActiveDefaultId] = useState<string>(resolvedDefault);
  const [isSavingDefault, setIsSavingDefault] = useState(false);
  const [defaultSaved, setDefaultSaved] = useState(false);
  const [defaultError, setDefaultError] = useState<string | null>(null);
  const defaultSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const [newName, setNewName] = useState("");
  const [newCurrency, setNewCurrency] = useState<"USD" | "SGD">("USD");
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (defaultSavedTimerRef.current) {
        clearTimeout(defaultSavedTimerRef.current);
      }
    };
  }, []);

  async function handleDefaultChange(nextDefaultId: string): Promise<void> {
    const previous = activeDefaultId;
    setActiveDefaultId(nextDefaultId);
    setDefaultError(null);
    setDefaultSaved(false);
    setIsSavingDefault(true);

    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultPortfolioId: nextDefaultId }),
      });

      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;

      if (!response.ok) {
        setActiveDefaultId(previous);
        setDefaultError(body?.error ?? "Unable to update default portfolio.");
        return;
      }

      setDefaultSaved(true);
      if (defaultSavedTimerRef.current) {
        clearTimeout(defaultSavedTimerRef.current);
      }
      defaultSavedTimerRef.current = setTimeout(() => {
        setDefaultSaved(false);
      }, 2200);

      onDefaultChanged?.(nextDefaultId);
      onChanged();
    } catch {
      setActiveDefaultId(previous);
      setDefaultError("Network error while saving default portfolio.");
    } finally {
      setIsSavingDefault(false);
    }
  }

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
      {holdingsPortfolios.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor="manage-default-portfolio"
              className="text-[13px] font-medium text-ink-2"
            >
              Default portfolio displayed
            </label>
            {isSavingDefault ? (
              <span className="inline-flex items-center gap-1 text-[11.5px] text-ink-2">
                <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                Saving...
              </span>
            ) : defaultSaved ? (
              <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-gain">
                <Check size={12} aria-hidden="true" />
                Saved
              </span>
            ) : null}
          </div>
          <div className="relative">
            <select
              id="manage-default-portfolio"
              value={activeDefaultId}
              disabled={isSavingDefault}
              onChange={(event) => void handleDefaultChange(event.target.value)}
              className="field-input h-10 appearance-none bg-field-bg pr-9 text-[14px]"
            >
              <option value="all">
                All portfolios ({holdingsPortfolios.length})
              </option>
              {holdingsPortfolios.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <ChevronDown
              size={16}
              strokeWidth={2}
              aria-hidden="true"
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-2"
            />
          </div>
          <p className="text-[12px] text-ink-3">
            Used as the initial portfolio filter on Dashboard, Holdings,
            Benchmarks, and Transactions.
          </p>
          {defaultError && (
            <p
              role="alert"
              className="flex items-center gap-1.5 text-[12.5px] text-loss"
            >
              <AlertCircle size={14} className="shrink-0" aria-hidden="true" />
              <span>{defaultError}</span>
            </p>
          )}
        </div>
      )}

      <div className="space-y-2.5">
        <div className="flex items-center justify-between">
          <h3 className="text-[13px] font-medium text-ink-2">
            Existing portfolios ({holdingsPortfolios.length})
          </h3>
        </div>
        <PortfolioRenameList
          portfolios={holdingsPortfolios}
          defaultPortfolioId={activeDefaultId}
          allowDelete
          onRenamed={() => onChanged()}
          onDeleted={(deleted) => {
            if (activeDefaultId === deleted.id) {
              setActiveDefaultId("all");
              onDefaultChanged?.("all");
            }
            onDeleted?.(deleted);
            onChanged();
          }}
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
              <option value="USD">USD (US Dollar)</option>
              <option value="SGD">SGD (Singapore Dollar)</option>
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
                <span>Creating...</span>
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
