"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { motion } from "framer-motion";
import { PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { NAV_ITEMS } from "@/components/app-shell/nav-items";
import { MarketStatusBadge } from "@/components/app-shell/market-status-badge";
import { SignOutButton } from "@/components/app-shell/sign-out-button";
import { BrandLogo } from "@/components/ui/brand-logo";
import { APP_NAME } from "@/lib/brand";
import { springSmooth, springSnappy } from "@/lib/motion";

const EXPANDED_WIDTH = 248;
const COLLAPSED_WIDTH = 72;

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
      className="sticky top-0 hidden h-dvh shrink-0 flex-col overflow-hidden border-r border-line bg-surface px-3 py-4 md:flex"
      aria-label="Desktop navigation"
    >
      <div className="mb-5 flex h-10 items-center justify-between px-2">
        {!isCollapsed && (
          <Link
            href="/dashboard"
            className="flex items-center gap-2.5 whitespace-nowrap text-[18px] font-semibold tracking-tight text-ink transition-opacity hover:opacity-90"
          >
            <BrandLogo size={26} />
            <span>{APP_NAME}</span>
          </Link>
        )}
        <button
          type="button"
          onClick={() => setIsCollapsed((collapsed) => !collapsed)}
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!isCollapsed}
          className="flex h-8 w-8 items-center justify-center rounded-[10px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
        >
          {isCollapsed ? (
            <PanelLeftOpen size={20} strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <PanelLeftClose size={20} strokeWidth={1.75} aria-hidden="true" />
          )}
        </button>
      </div>

      <button
        type="button"
        onClick={onOpenCommandPalette}
        aria-label="Search and jump to (Command K)"
        className="mb-4 flex h-9.5 items-center gap-3 rounded-[10px] border border-line bg-field-bg px-3 text-[14px] text-ink-2 transition-colors hover:border-ink-3/60 hover:text-ink"
      >
        <Search size={16} strokeWidth={1.75} aria-hidden="true" />
        {!isCollapsed && (
          <>
            <span className="flex-1 text-left">Search</span>
            <kbd className="rounded-[6px] border border-line bg-surface px-1.5 py-0.5 text-[11px] text-ink-2">
              ⌘K
            </kbd>
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
              className={`relative flex h-10 items-center gap-3 rounded-[10px] px-3 text-[14px] transition-colors duration-150 ${
                isActive
                  ? "font-semibold text-accent"
                  : "text-ink-2 hover:bg-surface-2 hover:text-ink"
              }`}
            >
              {isActive && (
                <motion.span
                  layoutId="sidebar-active-pill"
                  transition={springSnappy}
                  className="absolute inset-0 rounded-[10px] border border-accent/25 bg-accent/10"
                />
              )}
              <Icon
                size={20}
                strokeWidth={1.75}
                aria-hidden="true"
                className="relative shrink-0"
              />
              {!isCollapsed && (
                <span className="relative truncate">{label}</span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="flex flex-col gap-2.5 border-t border-line pt-4">
        <div className={isCollapsed ? "flex justify-center" : "px-0.5"}>
          <MarketStatusBadge compact={isCollapsed} />
        </div>
        <SignOutButton iconOnly={isCollapsed} />
      </div>
    </motion.aside>
  );
}

