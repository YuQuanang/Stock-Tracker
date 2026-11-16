"use client";

import { MotionConfig } from "framer-motion";
import { useEffect, type ReactNode } from "react";

/**
 * App-wide client providers.
 *
 * `reducedMotion="user"` makes Framer Motion honour the operating system's
 * "reduce motion" setting by turning transform/layout animations into plain
 * fades, as required for accessibility.
 *
 * In production (non-localhost), registers the static-asset PWA service
 * worker. In development or on localhost, actively unregisters any previously
 * installed service worker and clears static caches so `npm run dev` never
 * serves stale `/_next/static/` JS chunks from an earlier production build.
 */
export function Providers({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }

    const isLocalhost =
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1" ||
      window.location.hostname === "::1";

    if (process.env.NODE_ENV !== "production" || isLocalhost) {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) =>
          Promise.all(regs.map((registration) => registration.unregister())),
        )
        .catch(() => {});

      if ("caches" in window) {
        caches
          .keys()
          .then((keys) =>
            Promise.all(
              keys
                .filter(
                  (key) =>
                    key.startsWith("folio-static-") ||
                    key.startsWith("kestrel-static-"),
                )
                .map((key) => caches.delete(key)),
            ),
          )
          .catch(() => {});
      }
      return;
    }

    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // Ignore registration failures in restricted or private contexts.
    });
  }, []);

  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
