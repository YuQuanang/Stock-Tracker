import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  /** Buttons or links offering the next action. */
  actions?: ReactNode;
}

/**
 * Every empty or error screen says what happened in a human sentence and
 * offers a next action.
 */
export function EmptyState({ icon: Icon, title, description, actions }: EmptyStateProps) {
  return (
    <Card className="flex flex-col items-center px-6 py-14 text-center">
      <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-2 text-ink-2">
        <Icon size={26} strokeWidth={1.75} aria-hidden="true" />
      </div>
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <p className="mt-2 max-w-md text-[15px] leading-relaxed text-ink-2">{description}</p>
      {actions !== undefined && (
        <div className="mt-7 flex flex-wrap justify-center gap-3">{actions}</div>
      )}
    </Card>
  );
}

