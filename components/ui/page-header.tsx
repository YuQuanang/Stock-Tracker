import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  /** Right-aligned controls such as a portfolio picker or an Add button. */
  actions?: ReactNode;
}

/** Large, confident page title in the style of Apple's large titles. */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[34px] font-bold leading-tight tracking-tight">{title}</h1>
        {subtitle !== undefined && (
          <p className="mt-1 text-[15px] text-ink-2">{subtitle}</p>
        )}
      </div>
      {actions}
    </header>
  );
}

