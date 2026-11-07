import type { Metadata } from "next";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { ThemeToggle } from "@/components/theme-toggle";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" subtitle="Preferences for this device and your portfolio." />
      <Card className="divide-y divide-line">
        <div className="flex items-center justify-between gap-4 px-6 py-5">
          <div>
            <p className="font-medium">Appearance</p>
            <p className="text-[14px] text-ink-2">Follow your device, or choose light or dark.</p>
          </div>
          <ThemeToggle />
        </div>
        <div className="px-6 py-5 text-[14px] text-ink-2">
          Base currency, risk-free rate, dividend interpretation, colour scheme and number
          formats arrive with the features that use them.
        </div>
      </Card>
    </>
  );
}

