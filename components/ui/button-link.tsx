import Link from "next/link";
import type { ComponentProps } from "react";
import { getButtonClasses, type ButtonVariant } from "@/components/ui/button-styles";

interface ButtonLinkProps extends ComponentProps<typeof Link> {
  variant?: ButtonVariant;
}

/** A navigation link that looks like a button. Safe in server components. */
export function ButtonLink({ variant = "primary", className = "", ...rest }: ButtonLinkProps) {
  return <Link className={getButtonClasses(variant, className)} {...rest} />;
}

