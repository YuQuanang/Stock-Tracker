"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { NAV_ITEMS } from "@/components/app-shell/nav-items";
import { SignOutButton } from "@/components/app-shell/sign-out-button";
import { BrandLogo } from "@/components/ui/brand-logo";
import { APP_NAME } from "@/lib/brand";
import { fadeQuick, springSmooth } from "@/lib/motion";

interface MobileDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Slide-in navigation menu for screens below the `md` breakpoint. */
export function MobileDrawer({ isOpen, onClose }: MobileDrawerProps) {
  const pathname = usePathname();

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen, onClose]);

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={fadeQuick}
            onClick={onClose}
            className="absolute inset-0 bg-black/60"
            aria-hidden="true"
          />
          <motion.nav
            id="mobile-navigation"
            aria-label="Mobile navigation"
            initial={{ x: "-100%" }}
            animate={{ x: 0 }}
            exit={{ x: "-100%" }}
            transition={springSmooth}
            className="absolute inset-y-0 left-0 flex w-[280px] max-w-[85vw] flex-col border-r border-line bg-surface px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4"
          >
            <div className="mb-4 flex h-10 items-center justify-between px-2">
              <Link
                href="/dashboard"
                onClick={onClose}
                className="flex items-center gap-2.5 text-[18px] font-semibold tracking-tight text-ink"
              >
                <BrandLogo size={26} />
                <span>{APP_NAME}</span>
              </Link>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close menu"
                className="flex h-8 w-8 items-center justify-center rounded-[10px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <X size={20} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>

            <ul className="flex flex-1 flex-col gap-1 overflow-y-auto">
              {NAV_ITEMS.map(({ href, label, Icon }) => {
                const isActive = pathname === href || pathname.startsWith(`${href}/`);
                return (
                  <li key={href}>
                    <Link
                      href={href}
                      onClick={onClose}
                      aria-current={isActive ? "page" : undefined}
                      className={`flex h-11 items-center gap-3 rounded-[10px] border px-3 text-[14px] transition-colors duration-150 ${
                        isActive
                          ? "border-accent/25 bg-accent/10 font-semibold text-accent"
                          : "border-transparent text-ink-2 hover:bg-surface-2 hover:text-ink"
                      }`}
                    >
                      <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
                      <span>{label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>

            <div className="border-t border-line pt-3">
              <SignOutButton className="w-full" />
            </div>
          </motion.nav>
        </div>
      )}
    </AnimatePresence>
  );
}
