"use client";

import { motion } from "framer-motion";
import type { ComponentProps } from "react";
import { getButtonClasses, type ButtonVariant } from "@/components/ui/button-styles";
import { springSnappy } from "@/lib/motion";

interface ButtonProps extends Omit<ComponentProps<typeof motion.button>, "ref"> {
  variant?: ButtonVariant;
}

/** Pressed-state scale of about 0.98, as specified in the design language. */
export function Button({
  variant = "primary",
  className = "",
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <motion.button
      type={type}
      whileTap={{ scale: 0.98 }}
      transition={springSnappy}
      className={getButtonClasses(variant, className)}
      {...rest}
    />
  );
}
