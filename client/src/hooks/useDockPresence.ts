import { useLayoutEffect, useRef, useState } from "react";
import { motionMediumMs } from "@/lib/motion";

/**
 * Whether the dock is still on screen: open, or closed but still closing. The
 * width and the fade are CSS transitions on the dock itself, so the only thing
 * script has to know is when the closing is over — until then it keeps drawing
 * what was there (the panes are gone from the state the instant it closes) and
 * keeps the frame cut that follows its width; after it, it lets go of both.
 *
 * Open on mount is simply open: nothing animates on load, or on switching to a
 * tab whose dock is already open.
 */
export function useDockPresence(open: boolean): boolean {
  const [closing, setClosing] = useState(false);
  const wasOpen = useRef(open);

  useLayoutEffect(() => {
    const was = wasOpen.current;
    wasOpen.current = open;
    if (open) {
      setClosing(false);
      return;
    }
    // Closed on mount is not closing: there is nothing to see go.
    if (!was) return;
    setClosing(true);
    // A beat past the transition, so the last frame of it is drawn.
    const timer = window.setTimeout(() => setClosing(false), motionMediumMs() + 30);
    return () => window.clearTimeout(timer);
  }, [open]);

  return open || closing;
}
