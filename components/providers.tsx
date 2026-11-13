"use client";

import { MotionConfig } from "framer-motion";
import { useEffect, type ReactNode } from "react";

/**
 * App-wide client providers.
 *
 * `reducedMotion="user"` makes Framer Motion honour the operating system's
 * "reduce motion" setting by turning transform/layout animations into plain
 * fades, as required for accessibility. Also registers the static-asset PWA
 * service worker in production.
 */
export function Providers({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (
      process.env.NODE_ENV === "production" &&
      typeof window !== "undefined" &&
      "serviceWorker" in navigator
    ) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        // Ignore registration failures in restricted or private contexts.
      });
    }
  }, []);

  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}

