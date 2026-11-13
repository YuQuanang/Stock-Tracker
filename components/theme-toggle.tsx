"use client";

import { useSyncExternalStore } from "react";
import { LayoutGroup, motion } from "framer-motion";
import { Monitor, Moon, Sun } from "lucide-react";
import { springSnappy } from "@/lib/motion";
import { THEME_STORAGE_KEY, type ThemePreference } from "@/lib/theme";

/**
 * The preference is stored in localStorage, which React cannot observe, so we
 * expose it through useSyncExternalStore. This keeps server and client
 * rendering consistent and avoids setState-in-effect patterns.
 */
const changeListeners = new Set<() => void>();

function readPreference(): ThemePreference {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") {
    return stored;
  }
  return "system";
}

function applyResolvedTheme(preference: ThemePreference): void {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const useDark = preference === "dark" || (preference === "system" && prefersDark);
  document.documentElement.setAttribute("data-theme", useDark ? "dark" : "light");
}

function subscribe(onChange: () => void): () => void {
  changeListeners.add(onChange);

  // While following the system, react when the OS switches light/dark.
  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  function onSystemChange(): void {
    applyResolvedTheme(readPreference());
    onChange();
  }
  mediaQuery.addEventListener("change", onSystemChange);
  window.addEventListener("folio-theme-change", onChange);

  return () => {
    changeListeners.delete(onChange);
    mediaQuery.removeEventListener("change", onSystemChange);
    window.removeEventListener("folio-theme-change", onChange);
  };
}

function setPreference(preference: ThemePreference): void {
  window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  applyResolvedTheme(preference);
  changeListeners.forEach((listener) => listener());
}

const OPTIONS: { value: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

/** A compact three-way segmented control: System / Light / Dark. */
export function ThemeToggle() {
  const preference = useSyncExternalStore(
    subscribe,
    readPreference,
    () => "system" as ThemePreference,
  );

  return (
    <LayoutGroup id="sidebar-theme-toggle">
      <div
        role="radiogroup"
        aria-label="Theme"
        style={{ backgroundColor: "var(--seg-track)" }}
        className="inline-flex rounded-full border border-line/50 p-0.5"
      >
        {OPTIONS.map(({ value, label, Icon }) => {
          const isSelected = preference === value;
          return (
            <motion.button
              key={value}
              type="button"
              role="radio"
              aria-checked={isSelected}
              aria-label={label}
              title={label}
              whileTap={{ scale: 0.92 }}
              transition={springSnappy}
              onClick={() => setPreference(value)}
              className={`relative flex h-7 w-7 items-center justify-center rounded-full transition-colors duration-150 ${
                isSelected ? "text-ink" : "text-ink-3 hover:text-ink"
              }`}
            >
              {isSelected && (
                <motion.span
                  layoutId="sidebar-theme-pill"
                  transition={springSnappy}
                  style={{
                    borderRadius: 9999,
                    backgroundColor: "var(--seg-thumb)",
                    borderColor: "var(--seg-thumb-border)",
                    boxShadow: "var(--seg-thumb-shadow)",
                  }}
                  className="pointer-events-none absolute inset-0 border"
                />
              )}
              <Icon
                size={14}
                strokeWidth={2}
                aria-hidden="true"
                className="relative z-10"
              />
            </motion.button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}

