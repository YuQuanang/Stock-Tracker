import type { Metadata } from "next";
import { connection } from "next/server";
import { SettingsView } from "@/components/settings/settings-view";
import { PageHeader } from "@/components/ui/page-header";
import { listPortfolios, getOrCreateSettings } from "@/lib/services/ledger";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  await connection();
  const [initialSettings, initialPortfolios] = await Promise.all([
    getOrCreateSettings(),
    listPortfolios(),
  ]);

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Portfolio accounting rules, appearance preferences, exports, and data controls."
      />
      <SettingsView
        initialSettings={initialSettings}
        initialPortfolios={initialPortfolios}
      />
    </>
  );
}
