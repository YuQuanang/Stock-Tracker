"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { motion } from "framer-motion";
import { PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { NAV_ITEMS } from "@/components/app-shell/nav-items";
import { MarketStatusBadge } from "@/components/app-shell/market-status-badge";
import { SignOutButton } from "@/components/app-shell/sign-out-button";
import { ThemeToggle } from "@/components/theme-toggle";
import { springSmooth, springSnappy } from "@/lib/motion";

const EXPANDED_WIDTH = 260;
const COLLAPSED_WIDTH = 76;

interface SidebarProps {
  onOpenCommandPalette: () => void;
}

/** Desktop navigation. Hidden below the `md` breakpoint (the tab bar takes over). */
export function Sidebar({ onOpenCommandPalette }: SidebarProps) {
  const pathname = usePathname();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [pendingNav, setPendingNav] = useState<{ href: string; from: string } | null>(null);
  const effectivePathname =
    pendingNav && pendingNav.from === pathname ? pendingNav.href : pathname;

  return (
    <motion.aside
      initial={false}
      animate={{ width: isCollapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH }}
      transition={springSmooth}
      className="material sticky top-0 hidden h-dvh shrink-0 flex-col overflow-hidden border-r border-line px-3 py-5 md:flex"
      aria-label="Desktop navigation"
    >
      <div className="mb-6 flex h-10 items-center justify-between px-2">
        {!isCollapsed && (
          <span className="whitespace-nowrap text-[19px] font-semibold tracking-tight">
            Folio
          </span>
        )}
        <button
          type="button"
          onClick={() => setIsCollapsed((collapsed) => !collapsed)}
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!isCollapsed}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
        >
          {isCollapsed ? (
            <PanelLeftOpen size={18} strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <PanelLeftClose size={18} strokeWidth={1.75} aria-hidden="true" />
          )}
        </button>
      </div>

      <button
        type="button"
        onClick={onOpenCommandPalette}
        aria-label="Search and jump to (Command K)"
        className="mb-4 flex h-10 items-center gap-3 rounded-[var(--radius-control)] bg-surface-2 px-3 text-[15px] text-ink-3 transition-colors hover:text-ink"
      >
        <Search size={16} strokeWidth={1.75} aria-hidden="true" />
        {!isCollapsed && (
          <>
            <span className="flex-1 text-left">Search</span>
            <kbd className="rounded-md border border-line px-1.5 text-xs">⌘K</kbd>
          </>
        )}
      </button>

      <nav className="flex flex-1 flex-col gap-1">
        {NAV_ITEMS.map(({ href, label, Icon }) => {
          const isActive =
            effectivePathname === href || effectivePathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              onClick={() => {
                if (pathname !== href) {
                  setPendingNav({ href, from: pathname });
                }
              }}
              aria-current={isActive ? "page" : undefined}
              title={isCollapsed ? label : undefined}
              className={`relative flex h-10 items-center gap-3 rounded-[var(--radius-control)] px-3 text-[15px] transition-colors duration-200 ${
                isActive ? "text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink"
              }`}
            >
              {isActive && (
                <motion.span
                  layoutId="sidebar-active-pill"
                  transition={springSnappy}
                  className="absolute inset-0 rounded-[var(--radius-control)] bg-surface-2"
                />
              )}
              <Icon
                size={18}
                strokeWidth={1.75}
                aria-hidden="true"
                className="relative shrink-0"
              />
              {!isCollapsed && (
                <span className="relative truncate font-medium">{label}</span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="flex flex-col gap-2.5 border-t border-line pt-4">
        <div className={isCollapsed ? "flex justify-center" : "px-1"}>
          <MarketStatusBadge compact={isCollapsed} />
        </div>
        {!isCollapsed && (
          <div className="flex items-center justify-between px-3">
            <span className="text-sm text-ink-3">Theme</span>
            <ThemeToggle />
          </div>
        )}
        <SignOutButton iconOnly={isCollapsed} />
      </div>
    </motion.aside>
  );
}

