"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CornerDownLeft, Search } from "lucide-react";
import { NAV_ITEMS } from "@/components/app-shell/nav-items";
import { fadeQuick, springSnappy } from "@/lib/motion";

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Command palette (Command/Ctrl + K). In this milestone it jumps between
 * pages. Symbol search and quick actions are added in later milestones.
 */
export function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") {
      return NAV_ITEMS;
    }
    return NAV_ITEMS.filter((item) => {
      const haystack = `${item.label} ${item.keywords}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [query]);

  // Focus the input and lock background scroll when opening.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    inputRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  function close(): void {
    setQuery("");
    setHighlightedIndex(0);
    onClose();
  }

  function goTo(href: string): void {
    close();
    router.push(href);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((index) => Math.min(index + 1, matches.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      setHighlightedIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setHighlightedIndex(Math.max(matches.length - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = matches[highlightedIndex];
      if (chosen !== undefined) {
        goTo(chosen.href);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center bg-[#0E1117]/80 px-4 pt-[15vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={fadeQuick}
          onMouseDown={close}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            className="w-full max-w-lg overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-raised"
            initial={{ opacity: 0, y: -8, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.985 }}
            transition={springSnappy}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-3 border-b border-line px-4">
              <Search size={18} strokeWidth={1.75} className="text-ink-2" aria-hidden="true" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setHighlightedIndex(0);
                }}
                onKeyDown={handleKeyDown}
                placeholder="Jump to…"
                role="combobox"
                aria-expanded="true"
                aria-controls="command-palette-list"
                aria-activedescendant={
                  matches[highlightedIndex] ? `command-option-${highlightedIndex}` : undefined
                }
                className="h-12 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-3"
              />
            </div>

            <ul id="command-palette-list" role="listbox" className="max-h-80 overflow-y-auto p-2">
              {matches.length === 0 && (
                <li className="px-3 py-6 text-center text-[14px] text-ink-2">
                  Nothing matches “{query}”. Try a page name such as Holdings.
                </li>
              )}
              {matches.map(({ href, label, Icon }, index) => {
                const isHighlighted = index === highlightedIndex;
                return (
                  <li
                    key={href}
                    id={`command-option-${index}`}
                    role="option"
                    aria-selected={isHighlighted}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onClick={() => goTo(href)}
                    className={`flex h-10 cursor-pointer items-center gap-3 rounded-[10px] px-3 text-[14px] ${
                      isHighlighted ? "bg-surface-2 text-ink" : "text-ink-2"
                    }`}
                  >
                    <Icon size={20} strokeWidth={1.75} className={isHighlighted ? "text-accent" : "text-ink-2"} aria-hidden="true" />
                    <span className="flex-1 font-medium">{label}</span>
                    {isHighlighted && (
                      <CornerDownLeft size={16} className="text-ink-2" aria-hidden="true" />
                    )}
                  </li>
                );
              })}
            </ul>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

