/**
 * Theme and colour-scheme handling shared by the layout and the toggle.
 *
 * Preferences live in localStorage so the very first paint is correct (a tiny
 * inline script applies them before React hydrates, which prevents a white
 * flash in dark mode). The theme can also be saved to the settings table
 * later (Milestone 8).
 */
export type ThemePreference = "system" | "light" | "dark";
export type GainColorScheme = "green-up" | "red-up" | "color-blind-safe";

export const THEME_STORAGE_KEY = "folio-theme";
export const GAIN_SCHEME_STORAGE_KEY = "folio-gain-scheme";

/**
 * Runs in <head> before first paint. Kept as a plain string with no
 * dependencies on purpose. Errors are swallowed because private browsing
 * modes can block localStorage, and the app should still render.
 */
export const THEME_INIT_SCRIPT = `
(function () {
  try {
    document.documentElement.setAttribute("data-theme", "dark");

    var gainScheme = localStorage.getItem("${GAIN_SCHEME_STORAGE_KEY}");
    if (gainScheme) {
      document.documentElement.setAttribute("data-gain-scheme", gainScheme);
    }
  } catch (error) {}
})();
`;

