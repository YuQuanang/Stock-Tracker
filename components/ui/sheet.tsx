"use client";

import { AnimatePresence, motion, useDragControls } from "framer-motion";
import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { fadeQuick, springSmooth } from "@/lib/motion";

interface SheetProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  maxWidthClass?: string;
}

/**
 * Apple HIG Sheet:
 *  - Mobile (< 640px): Bottom-anchored sheet (`rounded-t-[26px]`) with rubber-band
 *    pull-down grabber, pinned header, scrollable content area, and safe-area
 *    bottom padding.
 *  - Desktop (>= 640px): Centered translucent floating sheet (`rounded-[22px]`)
 *    with crisp hairline chrome and pinned header.
 */
export function Sheet({
  isOpen,
  onClose,
  title,
  description,
  children,
  maxWidthClass = "sm:max-w-[520px]",
}: SheetProps) {
  const dragControls = useDragControls();

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape" && !event.defaultPrevented) {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 backdrop-blur-[2px] sm:items-center sm:px-4 sm:py-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={fadeQuick}
          onMouseDown={onClose}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            drag="y"
            dragControls={dragControls}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0.04, bottom: 0.45 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 110 || info.velocity.y > 550) {
                onClose();
              }
            }}
            initial={{ opacity: 0, y: 24, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 18, scale: 0.99 }}
            transition={springSmooth}
            onMouseDown={(event) => event.stopPropagation()}
            className={`material flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-[26px] border border-line bg-surface shadow-raised sm:max-h-[88dvh] sm:rounded-[22px] ${maxWidthClass}`}
          >
            {/* Mobile grabber handle */}
            <div
              aria-hidden="true"
              onPointerDown={(event) => dragControls.start(event)}
              className="flex shrink-0 cursor-grab touch-none justify-center pt-2.5 pb-1 sm:hidden"
            >
              <span className="h-1.25 w-9 rounded-full bg-ink-3/35" />
            </div>

            {/* Pinned Sheet Header */}
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-5 pt-2.5 pb-3.5 sm:px-6 sm:pt-5 sm:pb-4">
              <div className="min-w-0">
                <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-ink sm:text-[19px]">
                  {title}
                </h2>
                {description && (
                  <p className="mt-0.5 text-[13px] leading-[1.35] text-ink-2">
                    {description}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="flex h-7.5 w-7.5 shrink-0 items-center justify-center rounded-full bg-field-bg text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <X size={15} strokeWidth={2.25} aria-hidden="true" />
              </button>
            </div>

            {/* Scrollable Sheet Body */}
            <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-5">
              {children}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
