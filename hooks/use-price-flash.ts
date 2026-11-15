"use client";

import { useEffect, useRef } from "react";

/**
 * Triggers a 600ms CSS gain/loss flash on the returned element ref whenever a
 * live numeric price or portfolio total ticks up or down.
 */
export function usePriceFlashRef<T extends HTMLElement = HTMLElement>(
  numericValue: number | null | undefined,
) {
  const ref = useRef<T | null>(null);
  const prevRef = useRef<number | null>(null);

  useEffect(() => {
    if (
      numericValue === null ||
      numericValue === undefined ||
      !Number.isFinite(numericValue)
    ) {
      return;
    }

    const prev = prevRef.current;
    prevRef.current = numericValue;
    if (prev === null || prev === numericValue || !ref.current) {
      return;
    }

    const cls = numericValue > prev ? "tick-flash-gain" : "tick-flash-loss";
    const el = ref.current;
    el.classList.remove("tick-flash-gain", "tick-flash-loss");
    void el.offsetWidth;
    el.classList.add(cls);
  }, [numericValue]);

  return ref;
}

