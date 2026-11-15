import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  /** Right-aligned controls such as a portfolio picker or an Add button. */
  actions?: ReactNode;
}

/** Crisp dark-graphite header (18–20px section/view title, clean wrapping). */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-balance text-[20px] font-semibold leading-tight tracking-[-0.015em] text-ink sm:text-[22px]">
          {title}
        </h1>
        {subtitle !== undefined && (
          <p className="mt-1 text-pretty text-[14px] leading-snug text-ink-2">
            {subtitle}
          </p>
        )}
      </div>
      {actions}
    </header>
  );
}
