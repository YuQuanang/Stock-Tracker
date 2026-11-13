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
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4 sm:mb-8">
      <div className="min-w-0">
        <h1 className="text-[28px] font-bold leading-tight tracking-tight sm:text-[34px]">
          {title}
        </h1>
        {subtitle !== undefined && (
          <p className="mt-1 text-[14px] leading-snug text-ink-2 sm:text-[15px]">
            {subtitle}
          </p>
        )}
      </div>
      {actions}
    </header>
  );
}

