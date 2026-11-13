"use client";

import {
  AlertCircle,
  ChevronDown,
  FolderPlus,
  Loader2,
  Pencil,
  Trash2,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Portfolio } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";

interface WatchlistManageSheetProps {
  isOpen: boolean;
  activeWatchlist: Portfolio | null;
  totalWatchlists: number;
  onClose: () => void;
  onCreated: (newPortfolioId: string) => void;
  onUpdated: () => void;
  onDeleted: (deletedId: string) => void;
}

export function WatchlistManageSheet({
  isOpen,
  activeWatchlist,
  totalWatchlists,
  onClose,
  onCreated,
  onUpdated,
  onDeleted,
}: WatchlistManageSheetProps) {
  if (!isOpen) {
    return null;
  }

  return (
    <Sheet
      isOpen={isOpen}
      onClose={onClose}
      title="Manage watchlists"
      description="Organize watchlists by market or strategy, or rename your active list."
      maxWidthClass="max-w-md"
    >
      <WatchlistManageForm
        key={activeWatchlist?.id ?? "none"}
        activeWatchlist={activeWatchlist}
        totalWatchlists={totalWatchlists}
        onClose={onClose}
        onCreated={onCreated}
        onUpdated={onUpdated}
        onDeleted={onDeleted}
      />
    </Sheet>
  );
}

function WatchlistManageForm({
  activeWatchlist,
  totalWatchlists,
  onClose,
  onCreated,
  onUpdated,
  onDeleted,
}: Omit<WatchlistManageSheetProps, "isOpen">) {
  const [newName, setNewName] = useState("");
  const [newCurrency, setNewCurrency] = useState<"USD" | "SGD">("USD");
  const [renameValue, setRenameValue] = useState(activeWatchlist?.name ?? "");

  const [isCreating, setIsCreating] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) {
      setError("Enter a name for the new watchlist.");
      return;
    }

    setError(null);
    setIsCreating(true);
    try {
      const response = await fetch("/api/portfolios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmed,
          type: "watchlist",
          defaultCurrency: newCurrency,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "Unable to create watchlist.");
        setIsCreating(false);
        return;
      }

      onCreated(data.portfolio.id);
      onClose();
    } catch {
      setError("Network error while creating watchlist.");
      setIsCreating(false);
    }
  }

  async function handleRename(event: FormEvent) {
    event.preventDefault();
    if (!activeWatchlist) {
      return;
    }
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setError("Watchlist name cannot be empty.");
      return;
    }

    setError(null);
    setIsRenaming(true);
    try {
      const response = await fetch(`/api/portfolios/${activeWatchlist.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "Unable to rename watchlist.");
        setIsRenaming(false);
        return;
      }

      onUpdated();
      onClose();
    } catch {
      setError("Network error while renaming watchlist.");
      setIsRenaming(false);
    }
  }

  async function handleDelete() {
    if (!activeWatchlist) {
      return;
    }
    setError(null);
    setIsDeleting(true);
    try {
      const response = await fetch(`/api/portfolios/${activeWatchlist.id}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "Unable to delete watchlist.");
        setIsDeleting(false);
        return;
      }

      onDeleted(activeWatchlist.id);
      onClose();
    } catch {
      setError("Network error while deleting watchlist.");
      setIsDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Create new watchlist */}
      <form onSubmit={handleCreate} className="space-y-3">
        <div className="flex items-center gap-2">
          <FolderPlus className="h-4 w-4 text-accent" aria-hidden="true" />
          <h3 className="text-[14px] font-semibold text-ink">
            Create new watchlist
          </h3>
        </div>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[1fr_100px]">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. SG Dividends, AI Ideas"
            className="field-input"
          />
          <div className="relative">
            <select
              aria-label="Default currency"
              value={newCurrency}
              onChange={(e) =>
                setNewCurrency(e.target.value === "SGD" ? "SGD" : "USD")
              }
              className="field-input appearance-none pr-8"
            >
              <option value="USD">USD</option>
              <option value="SGD">SGD</option>
            </select>
            <ChevronDown
              size={14}
              strokeWidth={2}
              aria-hidden="true"
              className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3"
            />
          </div>
        </div>
        <div className="flex justify-end">
          <Button
            type="submit"
            disabled={isCreating}
            className="px-4 py-2 text-[13.5px]"
          >
            {isCreating ? (
              <>
                <Loader2
                  className="h-3.5 w-3.5 animate-spin"
                  aria-hidden="true"
                />
                Creating...
              </>
            ) : (
              "Create watchlist"
            )}
          </Button>
        </div>
      </form>

      {/* Active watchlist rename / delete */}
      {activeWatchlist && (
        <section className="space-y-3 border-t border-line pt-5">
          <div className="flex items-center gap-2">
            <Pencil className="h-4 w-4 text-ink-2" aria-hidden="true" />
            <h3 className="text-[14px] font-semibold text-ink">
              Active list: {activeWatchlist.name}
            </h3>
          </div>

          <form onSubmit={handleRename} className="flex items-center gap-2">
            <input
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              className="field-input flex-1"
            />
            <Button
              type="submit"
              variant="secondary"
              disabled={isRenaming || renameValue.trim() === activeWatchlist.name}
              className="h-11 shrink-0 px-4 text-[13.5px]"
            >
              {isRenaming ? "Saving..." : "Rename"}
            </Button>
          </form>

          {totalWatchlists > 0 && (
            <div className="pt-2">
              {!confirmDelete ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setConfirmDelete(true)}
                  className="px-2.5 py-1.5 text-[13px] text-loss hover:text-loss"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Delete &ldquo;{activeWatchlist.name}&rdquo;
                </Button>
              ) : (
                <div className="space-y-2.5 rounded-[12px] bg-loss/10 p-3.5">
                  <p className="text-[12.5px] leading-relaxed text-loss">
                    Delete &ldquo;{activeWatchlist.name}&rdquo; and remove its
                    watched items? Holdings transactions are unaffected.
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="danger"
                      disabled={isDeleting}
                      onClick={handleDelete}
                      className="px-3.5 py-1.5 text-[13px]"
                    >
                      {isDeleting ? "Deleting..." : "Confirm delete"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setConfirmDelete(false)}
                      className="px-3.5 py-1.5 text-[13px]"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-[12px] bg-loss/10 px-3.5 py-2.5 text-[13px] text-loss"
        >
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
