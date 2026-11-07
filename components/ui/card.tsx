import type { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
}

/** Soft layered surface: large radius, hairline border, subtle shadow. */
export function Card({ children, className = "" }: CardProps) {
  return (
    <div
      className={`rounded-[var(--radius-card)] border border-line bg-surface shadow-card ${className}`}
    >
      {children}
    </div>
  );
}

