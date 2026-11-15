import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { NAV_ITEMS, MOBILE_TAB_HREFS } from "@/components/app-shell/nav-items";
import { SignOutButton } from "@/components/app-shell/sign-out-button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = { title: "More" };

/** Mobile-only overflow page for destinations that do not fit in the tab bar. */
export default function MorePage() {
  const overflowItems = NAV_ITEMS.filter((item) => !MOBILE_TAB_HREFS.includes(item.href));

  return (
    <>
      <PageHeader title="More" />
      <Card className="divide-y divide-line">
        {overflowItems.map(({ href, label, Icon }) => (
          <Link
            key={href}
            href={href}
            className="flex h-13 items-center gap-3.5 px-5 text-[14px] transition-colors hover:bg-surface-2"
          >
            <Icon size={20} strokeWidth={1.75} className="text-ink-2" aria-hidden="true" />
            <span className="flex-1 font-medium text-ink">{label}</span>
            <ChevronRight size={16} strokeWidth={1.75} className="text-ink-3" aria-hidden="true" />
          </Link>
        ))}
        <div className="px-2 py-1">
          <SignOutButton className="w-full" />
        </div>
      </Card>
    </>
  );
}

