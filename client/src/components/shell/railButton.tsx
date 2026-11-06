import { cn } from "@/lib/utils";

/**
 * A button of the side panel's rail: the 30px square of the strip's own
 * buttons, and, for the pane on screen, the left sidebar's selected-row look
 * — the raised background and a 2px bar on the outer edge, the window's side
 * here as the sidebar's is on its left.
 */
export function railButtonClass(selected: boolean): string {
  return cn(
    "relative flex size-[30px] shrink-0 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
    selected ? "bg-bg-elevated text-foreground" : "hover:bg-bg-hover",
  );
}

/** The selected button's bar. */
export function RailSelectedMark({ selected }: { selected: boolean }) {
  if (!selected) return null;
  return <span aria-hidden="true" className="absolute inset-y-0 right-0 w-0.5 bg-muted-foreground" />;
}
