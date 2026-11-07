"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { useState } from "react";

interface SignOutButtonProps {
  /** When true, only the icon is shown (collapsed sidebar). */
  iconOnly?: boolean;
  className?: string;
}

export function SignOutButton({ iconOnly = false, className = "" }: SignOutButtonProps) {
  const router = useRouter();
  const [isSigningOut, setIsSigningOut] = useState(false);

  async function handleSignOut(): Promise<void> {
    setIsSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      disabled={isSigningOut}
      aria-label="Sign out"
      title="Sign out"
      className={`flex h-10 items-center gap-3 rounded-[var(--radius-control)] px-3 text-[15px] text-ink-2 transition-colors duration-200 hover:bg-surface-2 hover:text-ink disabled:opacity-50 ${className}`}
    >
      <LogOut size={18} strokeWidth={1.75} aria-hidden="true" />
      {!iconOnly && <span>Sign out</span>}
    </button>
  );
}

