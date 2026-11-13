/**
 * Shared spring and duration presets so every animation in the app feels
 * consistent. Durations stay short (150-350 ms) with no gratuitous bounce.
 */
import type { Transition } from "framer-motion";

/** Default for layout changes, sheets, dialogs, and drawer transitions. */
export const springSmooth: Transition = {
  type: "spring",
  stiffness: 460,
  damping: 42,
  mass: 0.78,
};

/** Instant, crisp feedback for segmented controls, nav pills, and button taps. */
export const springSnappy: Transition = {
  type: "spring",
  stiffness: 580,
  damping: 46,
  mass: 0.65,
};

/** Fast Apple ease-out curve for overlays, route cross-fades, and tab switches. */
export const fadeQuick: Transition = {
  duration: 0.14,
  ease: [0.22, 1, 0.36, 1],
};

/** Delay between items in staggered list entrances, in seconds. */
export const STAGGER_SECONDS = 0.04;

