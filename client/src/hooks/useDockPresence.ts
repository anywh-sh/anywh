import { usePanelTransition } from "@/hooks/usePanelTransition";

/**
 * Whether the dock is still on screen: open, or closed but still closing. The
 * width and the fade are CSS transitions on the dock itself, so the only thing
 * script has to know is when the closing is over (see `usePanelTransition`).
 */
export function useDockPresence(open: boolean): boolean {
  return usePanelTransition(open).present;
}
