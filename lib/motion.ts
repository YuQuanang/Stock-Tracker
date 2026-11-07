/**
 * Shared spring and duration presets so every animation in the app feels
 * consistent. Durations stay short (150-350 ms) with no gratuitous bounce.
 */
import type { Transition } from "framer-motion";

/** Default for layout changes, list reordering and shared-element morphs. */
export const springSmooth: Transition = {
  type: "spring",
  stiffness: 380,
  damping: 38,
  mass: 0.9,
};

/** Slightly firmer, for small controls such as segmented-control thumbs. */
export const springSnappy: Transition = {
  type: "spring",
  stiffness: 520,
  damping: 42,
  mass: 0.7,
};

/** For quick fades and opacity changes. */
export const fadeQuick: Transition = {
  duration: 0.18,
  ease: [0.25, 0.1, 0.25, 1],
};

/** Delay between items in staggered list entrances, in seconds. */
export const STAGGER_SECONDS = 0.04;

