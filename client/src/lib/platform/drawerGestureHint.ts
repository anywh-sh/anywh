/**
 * Whether a touch that just began should leave the native drawer pan alone.
 *
 * The drawer gesture starts anywhere on screen, so a horizontally scrolling
 * block (a code block, a wide tool output) would lose its own scroll to it.
 * Only the nearest horizontal scroller counts, and only when it is already
 * scrolled: at its start edge a drag to the right has nowhere to go, so it
 * is free to open the drawer.
 */
export function blocksDrawerGesture(target: EventTarget | null): boolean {
  let node = target instanceof Element ? target : null;
  while (node) {
    const { overflowX } = getComputedStyle(node);
    if ((overflowX === "auto" || overflowX === "scroll") && node.scrollWidth > node.clientWidth) {
      return node.scrollLeft > 0;
    }
    node = node.parentElement;
  }
  return false;
}
