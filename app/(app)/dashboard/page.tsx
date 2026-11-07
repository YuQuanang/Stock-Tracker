import type { Metadata } from "next";
import { FileUp, Plus } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { ButtonLink } from "@/components/ui/button-link";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardPage() {
  return (
    <>
      <PageHeader title="Dashboard" subtitle="Your portfolio at a glance." />
      <EmptyState
        icon={FileUp}
        title="Welcome to Folio"
        description="Bring in your existing portfolio from a Microsoft Start / MSN Money CSV export, or start with a blank slate and add transactions yourself."
        actions={
          <>
            <ButtonLink href="/import-export">
              <FileUp size={18} strokeWidth={1.75} aria-hidden="true" />
              Import my CSV
            </ButtonLink>
            <ButtonLink href="/transactions" variant="secondary">
              <Plus size={18} strokeWidth={1.75} aria-hidden="true" />
              Start empty
            </ButtonLink>
          </>
        }
      />
    </>
  );
}

