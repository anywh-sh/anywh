import { useLayoutEffect, type RefObject } from "react";

/** What has to line up with the dock's edge: the plane's frame and the status
 * bar's top rule (the rules at the end of `index.css`, the same two the room's
 * side panel cuts in `sala.css`). */
const OUTSIDE = "[data-plane-frame], [data-status-bar]";
const EDGE = "data-dock-edge";

/**
 * Makes the dock read like the room's side panel: docked on the window's
 * chrome, outside the plane's frame, so the main container is the one framed
 * thing and the panel beside it is not boxed in. The panel cannot draw that
 * itself — the frame belongs to the shell, over the whole plane — so it
 * publishes where it is: it marks itself (`data-dock-edge`) when it touches
 * the plane's right edge, and gives the frame and the status bar its width,
 * which the rules in `index.css` cut them by.
 *
 * Only a dock at the plane's right edge cuts anything. In a split, the group
 * to the left keeps the frame all around it, and the dock that is inside the
 * plane stays inside it. Measured rather than passed in, because which group
 * is last is a fact of the layout, and the layout moves (a drag, a split, a
 * window resize).
 */
export function useDockFrameCut(ref: RefObject<HTMLElement | null>, active: boolean, width: number): void {
  useLayoutEffect(() => {
    const dock = ref.current;
    if (!dock) return;
    function publish(): void {
      const edge = document.querySelector<HTMLElement>(`[${EDGE}]`);
      // The width it has now, not the one it is heading for: while it opens or
      // closes the cut follows it, frame by frame.
      const px = edge ? `${edge.getBoundingClientRect().width}px` : "0px";
      for (const el of document.querySelectorAll<HTMLElement>(OUTSIDE)) el.style.setProperty("--dock-side-w", px);
    }

    function sync(): void {
      const frame = document.querySelector<HTMLElement>("[data-plane-frame]");
      const touchesRight = active && frame !== null && Math.abs(dock!.getBoundingClientRect().right - frame.getBoundingClientRect().right) <= 1;
      if (touchesRight) dock!.setAttribute(EDGE, "");
      else dock!.removeAttribute(EDGE);
      publish();
    }

    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(dock);
    const frame = document.querySelector("[data-plane-frame]");
    if (frame) observer.observe(frame);
    return () => {
      observer.disconnect();
      dock.removeAttribute(EDGE);
      publish();
    };
  }, [ref, active, width]);
}
