"use client";

import { useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import { BrandLogo } from "@/components/ui/brand-logo";
import { Button } from "@/components/ui/button";
import { APP_NAME } from "@/lib/brand";
import { springSmooth } from "@/lib/motion";

interface LoginFormProps {
  /** Already sanitised on the server by getSafeNextPath. */
  nextPath: string;
}

export function LoginForm({ nextPath }: LoginFormProps) {
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ password }),
      });

      if (response.ok) {
        // Full document navigation guarantees the new session cookie is sent cleanly
        // past any proxy/CDN caches without a stale /login RSC payload bouncing back.
        window.location.assign(nextPath);
        return;
      }

      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setErrorMessage(body?.error ?? "Something went wrong. Please try again.");
    } catch {
      setErrorMessage("Could not reach the server. Check your connection and try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <motion.form
      onSubmit={handleSubmit}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={springSmooth}
      className="w-full max-w-sm rounded-[var(--radius-card)] border border-line bg-surface-2 p-6 shadow-raised"
    >
      <div className="mb-6 flex flex-col items-center text-center">
        <BrandLogo size={48} className="mb-4" />
        <h1 className="text-[20px] font-semibold tracking-[-0.015em] text-ink">
          {APP_NAME}
        </h1>
        <p className="mt-1 text-[14px] text-ink-2">Enter your password to continue.</p>
      </div>

      <label htmlFor="password" className="sr-only">
        Password
      </label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        autoFocus
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        aria-invalid={errorMessage !== null}
        aria-describedby={errorMessage !== null ? "login-error" : undefined}
        placeholder="Password"
        className="field-input h-11 px-3.5 text-[14px]"
      />

      {errorMessage !== null && (
        <p id="login-error" role="alert" className="mt-3 text-[14px] text-loss">
          {errorMessage}
        </p>
      )}

      <Button
        type="submit"
        disabled={isSubmitting || password === ""}
        className="mt-5 w-full"
      >
        {isSubmitting ? "Signing in…" : "Sign in"}
      </Button>
    </motion.form>
  );
}

