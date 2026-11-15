import type { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
  raised?: boolean;
}

/** Flat graphite surface (`#161B22`, `16px` radius, `1px #262D38` border). */
export function Card({ children, className = "", raised = false }: CardProps) {
  return (
    <div
      className={`rounded-[var(--radius-card)] border border-line ${
        raised ? "bg-surface-2 shadow-raised" : "bg-surface"
      } ${className}`}
    >
      {children}
    </div>
  );
}
