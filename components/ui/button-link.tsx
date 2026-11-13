import Link from "next/link";
import type { ComponentProps } from "react";
import {
  getButtonClasses,
  type ButtonShape,
  type ButtonSize,
  type ButtonVariant,
} from "@/components/ui/button-styles";

interface ButtonLinkProps extends ComponentProps<typeof Link> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  shape?: ButtonShape;
}

/** A navigation link that looks like a button. Safe in server components. */
export function ButtonLink({
  variant = "primary",
  size = "md",
  shape = "rounded",
  className = "",
  ...rest
}: ButtonLinkProps) {
  return (
    <Link
      className={getButtonClasses(variant, className, size, shape)}
      {...rest}
    />
  );
}

