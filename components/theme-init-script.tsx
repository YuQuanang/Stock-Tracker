"use client";

import { THEME_INIT_SCRIPT } from "@/lib/theme";

/**
 * Synchronously sets stored display preferences (e.g. gain colour scheme) before
 * body content paints, using Next.js 16's server-script/client-plain pattern so
 * React 19 never flags a script hydration mismatch.
 */
export function ThemeInitScript() {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
    />
  );
}

