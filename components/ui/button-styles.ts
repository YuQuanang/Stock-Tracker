/**
 * Button styling shared by <Button> (client) and <ButtonLink> (works in server
 * components). Kept in a plain module so it can be imported from either.
 */
export type ButtonVariant =
  | "primary"
  | "secondary"
  | "tinted"
  | "ghost"
  | "danger";
export type ButtonSize = "md" | "sm" | "xs";
export type ButtonShape = "rounded" | "pill";

const BASE_CLASSES =
  "inline-flex items-center justify-center whitespace-nowrap font-medium tracking-[-0.01em] transition-all duration-150 active:scale-[0.985] disabled:pointer-events-none disabled:opacity-45";

const SIZE_CLASSES: Record<ButtonSize, string> = {
  md: "h-11 gap-2 px-4.5 text-[15px]",
  sm: "h-9 gap-1.5 px-3.5 text-[13.5px]",
  xs: "h-7 gap-1.5 px-2.5 text-[12px]",
};

const SHAPE_CLASSES: Record<ButtonShape, Record<ButtonSize, string>> = {
  rounded: {
    md: "rounded-[11px]",
    sm: "rounded-[10px]",
    xs: "rounded-[8px]",
  },
  pill: {
    md: "rounded-full",
    sm: "rounded-full",
    xs: "rounded-full",
  },
};

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-ink shadow-xs hover:brightness-105",
  secondary:
    "border border-line bg-surface-2/80 text-ink hover:bg-surface-2",
  tinted: "bg-accent/12 text-accent hover:bg-accent/18",
  ghost: "bg-transparent text-ink-2 hover:bg-surface-2/80 hover:text-ink",
  danger: "bg-loss text-white shadow-xs hover:brightness-105",
};

export function getButtonClasses(
  variant: ButtonVariant,
  extra: string = "",
  size: ButtonSize = "md",
  shape: ButtonShape = "rounded",
): string {
  return `${BASE_CLASSES} ${SIZE_CLASSES[size]} ${SHAPE_CLASSES[shape][size]} ${VARIANT_CLASSES[variant]} ${extra}`.trim();
}
