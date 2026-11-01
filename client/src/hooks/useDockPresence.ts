import { useLayoutEffect, useState } from "react";
import { motionFastMs } from "@/lib/motion";

/**
 * The two halves of the dock opening and closing, which are not the same
 * moment. `shown` is whether it takes space in the layout; `visible` is
 * whether it is slid into place. Width is a layout property and is never
 * animated (see `designVocabulary.test.ts`: a panel toggle is where that
 * costs a layout pass per frame), so the motion is a transform and the layout
 * is kept honest around it:
 *
 *  - opening: it takes its space at once, then, a frame later, slides in;
 *  - closing: it slides out first, and gives the space back once it is gone.
 *
 * A dock that is open on mount is simply there — nothing animates on load.
 */
export function useDockPresence(open: boolean): { shown: boolean; visible: boolean } {
  const [shown, setShown] = useState(open);
  const [visible, setVisible] = useState(open);

  useLayoutEffect(() => {
    if (open) {
      setShown(true);
      // Two frames: the first paints it where it starts (off to the right),
      // the second moves it, so there is a start for the transition to run from.
      let second = 0;
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setVisible(true));
      });
      return () => {
        cancelAnimationFrame(first);
        cancelAnimationFrame(second);
      };
    }
    setVisible(false);
    const timer = window.setTimeout(() => setShown(false), motionFastMs());
    return () => window.clearTimeout(timer);
  }, [open]);

  return { shown, visible };
}
