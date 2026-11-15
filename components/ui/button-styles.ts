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
  "inline-flex items-center justify-center whitespace-nowrap font-medium tracking-[-0.01em] transition-colors duration-150 active:scale-[0.985] disabled:pointer-events-none disabled:opacity-45";

const SIZE_CLASSES: Record<ButtonSize, string> = {
  md: "h-10 gap-2 px-4 text-[14px]",
  sm: "h-9 gap-1.5 px-3 text-[13px]",
  xs: "h-7.5 gap-1.5 px-2.5 text-[12px]",
};

const SHAPE_CLASSES: Record<ButtonShape, Record<ButtonSize, string>> = {
  rounded: {
    md: "rounded-[10px]",
    sm: "rounded-[10px]",
    xs: "rounded-[8px]",
  },
  pill: {
    md: "rounded-[10px]",
    sm: "rounded-[10px]",
    xs: "rounded-[8px]",
  },
};

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-accent-ink font-semibold hover:brightness-110",
  secondary:
    "border border-line bg-surface-2 text-ink hover:border-ink-3/60 hover:bg-[#222934]",
  tinted:
    "border border-accent/25 bg-accent/12 text-accent hover:bg-accent/18",
  ghost:
    "bg-transparent text-ink-2 hover:bg-surface-2 hover:text-ink",
  danger:
    "bg-loss text-white font-semibold hover:brightness-110",
};

export function getButtonClasses(
  variant: ButtonVariant,
  extra: string = "",
  size: ButtonSize = "md",
  shape: ButtonShape = "rounded",
): string {
  return `${BASE_CLASSES} ${SIZE_CLASSES[size]} ${SHAPE_CLASSES[shape][size]} ${VARIANT_CLASSES[variant]} ${extra}`.trim();
}
