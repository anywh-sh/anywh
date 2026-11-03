import { useLayoutEffect, useRef, useState } from "react";
import { motionMediumMs } from "@/lib/motion";

/**
 * A panel that opens and closes by a CSS transition on its own box, as seen
 * from script: when it is there to be drawn, and when it is still moving.
 *
 *  - `present`: open, or closed but still closing. It keeps drawing what was
 *    there (the panel's state is gone the instant it closes) until the
 *    transition has run out, and lets go after it.
 *  - `transitioning`: opening or closing. For whatever has to stay as it was
 *    until the panel has finished arriving — the sidebar's controls, which
 *    float over the tab strip while it is closed and must not jump into the
 *    column before the column is there.
 *
 * Open on mount is simply open: nothing animates on load, or on mounting a
 * panel that is already open. Closed on mount is not closing.
 */
export function usePanelTransition(open: boolean): { present: boolean; transitioning: boolean } {
  const [transitioning, setTransitioning] = useState(false);
  const [closing, setClosing] = useState(false);
  const wasOpen = useRef(open);

  // The render in which `open` flips is the one that matters most — it is the
  // one that gets drawn — and the state set in the effect below only lands in
  // the next. So the answer is also worked out from the flip itself: a panel
  // that has just closed is still present, and one that has just flipped is
  // already transitioning. Without it the content of a closing panel would be
  // unmounted for a render and mounted again, and a fresh element has no
  // previous style to fade from.
  const flipped = wasOpen.current !== open;
  const justClosed = flipped && !open;

  useLayoutEffect(() => {
    const was = wasOpen.current;
    wasOpen.current = open;
    if (was === open) return;
    setTransitioning(true);
    setClosing(!open);
    // A beat past the transition, so the last frame of it is drawn.
    const timer = window.setTimeout(() => {
      setTransitioning(false);
      setClosing(false);
    }, motionMediumMs() + 30);
    return () => window.clearTimeout(timer);
  }, [open]);

  return { present: open || closing || justClosed, transitioning: transitioning || flipped };
}
