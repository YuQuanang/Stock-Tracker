import type { Metadata } from "next";
import { connection } from "next/server";
import { SettingsView } from "@/components/settings/settings-view";
import { PageHeader } from "@/components/ui/page-header";
import { getOrCreateSettings } from "@/lib/services/ledger";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  await connection();
  const initialSettings = await getOrCreateSettings();

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Portfolio accounting rules, appearance preferences, exports, and data controls."
      />
      <SettingsView initialSettings={initialSettings} />
    </>
  );
}
