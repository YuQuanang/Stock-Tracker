"use client";

import { useState } from "react";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutGroup, motion } from "framer-motion";
import { Ellipsis } from "lucide-react";
import { MOBILE_TAB_HREFS, NAV_ITEMS } from "@/components/app-shell/nav-items";
import { springSnappy } from "@/lib/motion";

/** Mobile bottom tab bar with large touch targets and iOS active pill. */
export function TabBar() {
  const pathname = usePathname();
  const [pendingNav, setPendingNav] = useState<{ href: string; from: string } | null>(null);
  const effectivePathname =
    pendingNav && pendingNav.from === pathname ? pendingNav.href : pathname;

  const tabItems = NAV_ITEMS.filter((item) => MOBILE_TAB_HREFS.includes(item.href));
  const moreIsActive = !tabItems.some((item) =>
    effectivePathname.startsWith(item.href),
  );

  return (
    <LayoutGroup id="mobile-tabbar">
      <nav
        aria-label="Mobile navigation"
        className="material fixed inset-x-0 bottom-0 z-30 border-t border-line pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <ul className="mx-auto flex max-w-md items-stretch justify-around px-1">
          {tabItems.map(({ href, label, Icon }) => {
            const isActive =
              effectivePathname === href || effectivePathname.startsWith(`${href}/`);
            return (
              <li key={href} className="flex-1">
                <Link
                  href={href}
                  onClick={() => {
                    if (pathname !== href) {
                      setPendingNav({ href, from: pathname });
                    }
                  }}
                  aria-current={isActive ? "page" : undefined}
                  className={`relative flex h-[54px] flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors duration-150 ${
                    isActive ? "text-accent" : "text-ink-3"
                  }`}
                >
                  {isActive && (
                    <motion.span
                      layoutId="tabbar-active-pill"
                      transition={springSnappy}
                      className="pointer-events-none absolute inset-x-1.5 inset-y-1.5 rounded-[12px] bg-accent/10"
                    />
                  )}
                  <motion.span
                    whileTap={{ scale: 0.88 }}
                    transition={springSnappy}
                    className="relative z-10"
                  >
                    <Icon size={21} strokeWidth={1.8} aria-hidden="true" />
                  </motion.span>
                  <span className="relative z-10">{label}</span>
                </Link>
              </li>
            );
          })}
          <li className="flex-1">
            <Link
              href="/more"
              onClick={() => {
                if (pathname !== "/more") {
                  setPendingNav({ href: "/more", from: pathname });
                }
              }}
              aria-current={effectivePathname === "/more" ? "page" : undefined}
              className={`relative flex h-[54px] flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors duration-150 ${
                moreIsActive ? "text-accent" : "text-ink-3"
              }`}
            >
              {moreIsActive && (
                <motion.span
                  layoutId="tabbar-active-pill"
                  transition={springSnappy}
                  className="pointer-events-none absolute inset-x-1.5 inset-y-1.5 rounded-[12px] bg-accent/10"
                />
              )}
              <motion.span
                whileTap={{ scale: 0.88 }}
                transition={springSnappy}
                className="relative z-10"
              >
                <Ellipsis size={21} strokeWidth={1.8} aria-hidden="true" />
              </motion.span>
              <span className="relative z-10">More</span>
            </Link>
          </li>
        </ul>
      </nav>
    </LayoutGroup>
  );
}

