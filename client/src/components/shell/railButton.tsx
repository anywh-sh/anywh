import type { ComponentProps } from "react";
import { RowButton } from "@/components/ui/row-button";
import { cn } from "@/lib/utils";

/**
 * A button of the side panel's rail, drawn like a row of the left sidebar:
 * the rail's whole width, the hover and the selected look running edge to
 * edge — the raised background and, for the pane on screen, a 2px bar on the
 * outer edge, the window's side here as the sidebar's is on its left. Every
 * rail button is one of these, so the column reads as one control.
 */
export function RailButton({ selected = false, className, ...props }: Omit<ComponentProps<typeof RowButton>, "mark" | "size" | "tone">) {
  return <RowButton selected={selected} mark="end" className={cn("h-9 justify-center px-0", className)} {...props} />;
}
