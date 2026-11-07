"use client";

import { MotionConfig } from "framer-motion";
import type { ReactNode } from "react";

/**
 * App-wide client providers.
 *
 * `reducedMotion="user"` makes Framer Motion honour the operating system's
 * "reduce motion" setting by turning transform/layout animations into plain
 * fades, as required for accessibility.
 */
export function Providers({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}

