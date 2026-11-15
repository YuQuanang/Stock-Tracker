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
    <Card className="flex flex-col items-center px-5 py-12 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-[12px] border border-line bg-surface-2 text-ink-2">
        <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
      </div>
      <h2 className="text-[18px] font-semibold tracking-[-0.015em] text-ink">{title}</h2>
      <p className="mt-1.5 max-w-md text-[14px] leading-relaxed text-ink-2">{description}</p>
      {actions !== undefined && (
        <div className="mt-6 flex flex-wrap justify-center gap-3">{actions}</div>
      )}
    </Card>
  );
}

