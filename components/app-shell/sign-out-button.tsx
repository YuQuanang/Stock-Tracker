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
      className={`flex h-10 items-center gap-3 rounded-[10px] px-3 text-[14px] text-ink-2 transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:opacity-50 ${className}`}
    >
      <LogOut size={20} strokeWidth={1.75} aria-hidden="true" />
      {!iconOnly && <span>Sign out</span>}
    </button>
  );
}

