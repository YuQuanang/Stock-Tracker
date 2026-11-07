/**
 * Button styling shared by <Button> (client) and <ButtonLink> (works in server
 * components). Kept in a plain module so it can be imported from either.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BASE_CLASSES =
  "inline-flex h-11 items-center justify-center gap-2 rounded-[11px] px-4.5 text-[15px] font-medium tracking-[-0.01em] transition-all duration-150 active:scale-[0.985] disabled:pointer-events-none disabled:opacity-45";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-ink shadow-xs hover:brightness-105",
  secondary:
    "border border-line bg-surface-2/80 text-ink hover:bg-surface-2",
  ghost: "bg-transparent text-ink-2 hover:bg-surface-2/80 hover:text-ink",
  danger: "bg-loss text-white shadow-xs hover:brightness-105",
};

export function getButtonClasses(
  variant: ButtonVariant,
  extra: string = "",
): string {
  return `${BASE_CLASSES} ${VARIANT_CLASSES[variant]} ${extra}`.trim();
}
