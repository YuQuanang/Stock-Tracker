"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { Ellipsis } from "lucide-react";
import { MOBILE_TAB_HREFS, NAV_ITEMS } from "@/components/app-shell/nav-items";
import { springSnappy } from "@/lib/motion";

/** Mobile bottom tab bar with large touch targets. Hidden from `md` upwards. */
export function TabBar() {
  const pathname = usePathname();

  const tabItems = NAV_ITEMS.filter((item) => MOBILE_TAB_HREFS.includes(item.href));
  const moreIsActive = !tabItems.some((item) => pathname.startsWith(item.href));

  return (
    <nav
      aria-label="Primary"
      className="material fixed inset-x-0 bottom-0 z-30 border-t border-line pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="mx-auto flex max-w-md items-stretch justify-around">
        {tabItems.map(({ href, label, Icon }) => {
          const isActive = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                aria-current={isActive ? "page" : undefined}
                className={`flex h-[54px] flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors duration-200 ${
                  isActive ? "text-accent" : "text-ink-3"
                }`}
              >
                <motion.span whileTap={{ scale: 0.9 }} transition={springSnappy}>
                  <Icon size={22} strokeWidth={1.75} aria-hidden="true" />
                </motion.span>
                {label}
              </Link>
            </li>
          );
        })}
        <li className="flex-1">
          <Link
            href="/more"
            aria-current={pathname === "/more" ? "page" : undefined}
            className={`flex h-[54px] flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors duration-200 ${
              moreIsActive ? "text-accent" : "text-ink-3"
            }`}
          >
            <motion.span whileTap={{ scale: 0.9 }} transition={springSnappy}>
              <Ellipsis size={22} strokeWidth={1.75} aria-hidden="true" />
            </motion.span>
            More
          </Link>
        </li>
      </ul>
    </nav>
  );
}

