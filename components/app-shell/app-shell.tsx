"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { Search } from "lucide-react";
import { CommandPalette } from "@/components/app-shell/command-palette";
import { Footer } from "@/components/app-shell/footer";
import { MarketStatusBadge } from "@/components/app-shell/market-status-badge";
import { Sidebar } from "@/components/app-shell/sidebar";
import { TabBar } from "@/components/app-shell/tab-bar";
import { fadeQuick } from "@/lib/motion";

/**
 * Layout frame for every signed-in page: sidebar on desktop, tab bar on
 * mobile, a global Command/Ctrl+K shortcut, skip-to-content navigation, and footer.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      const isShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      if (isShortcut) {
        event.preventDefault();
        setIsPaletteOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="flex min-h-dvh">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-full focus:bg-accent focus:px-4 focus:py-2 focus:text-[13px] focus:font-semibold focus:text-accent-ink focus:shadow-raised"
      >
        Skip to main content
      </a>

      <Sidebar onOpenCommandPalette={() => setIsPaletteOpen(true)} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile Apple top bar (< 768px): Wordmark, Search, and full US + SGX Market Hours */}
        <header className="material sticky top-0 z-30 space-y-2 border-b border-line px-4 py-2.5 md:hidden">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[17px] font-semibold tracking-tight text-ink">
              Folio
            </span>
            <button
              type="button"
              onClick={() => setIsPaletteOpen(true)}
              aria-label="Search and jump to"
              className="flex h-8.5 w-8.5 shrink-0 items-center justify-center rounded-full bg-surface-2 text-ink-2 transition-colors hover:text-ink"
            >
              <Search size={16} strokeWidth={1.9} aria-hidden="true" />
            </button>
          </div>
          <MarketStatusBadge layout="inline" />
        </header>

        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-6xl flex-1 px-4 pb-28 pt-5 outline-none sm:px-6 md:px-10 md:pb-12 md:pt-10"
        >
          <motion.div
            key={pathname}
            initial={{ opacity: 0.85, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            transition={fadeQuick}
          >
            {children}
          </motion.div>
          <Footer />
        </main>
      </div>

      <TabBar />
      <CommandPalette isOpen={isPaletteOpen} onClose={() => setIsPaletteOpen(false)} />
    </div>
  );
}

