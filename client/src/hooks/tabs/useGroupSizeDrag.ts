import { useCallback, useRef, useState } from "react";
import { MIN_USABLE_CHAT_PX, MIN_WIDTH_WITH_FILES } from "@/hooks/tabs/useSessionDock";

/** Floor for a group's width, in px — below this a chat column stops being
 * usable once a dock sits at its own minimum next to it. Sized as the
 * dock's own floor with the files pane open plus a usable chat width (see
 * `useSessionDock.ts`'s `MIN_USABLE_CHAT_PX`), not just an arbitrary chat-only
 * number — a group can host a dock, so its own minimum has to account for one. */
export const MIN_GROUP_PX = MIN_WIDTH_WITH_FILES + MIN_USABLE_CHAT_PX;

// The most of a pair's width the floor may take, per group. `MIN_GROUP_PX` is
// an aspiration that stops fitting on an ordinary window, and a floor that is
// the aspiration where it fits and something else where it does not makes the
// handle free to move with the sidebar open and stuck against a wall with it
// closed (the same pair, a wider container). Capping the floor at a share of
// the pair keeps the handle's range the same at any window size, and always
// leaves half the pair to move in; it also keeps a group from ever reaching 0
// (which would corrupt the virtualizer's height cache, the same invariant
// `TabGroupLayout`'s `invisible`-not-`display:none` panels protect).
const MAX_FLOOR_SHARE_OF_PAIR = 0.25;

/** How much of `rawDelta` (the pointer's raw movement, in fraction-of-container
 * space) actually gets applied to the pair of adjacent groups sharing a
 * resize handle, clamped so neither group's fraction drops below
 * `minFraction` (in the common case, `MIN_GROUP_PX` converted to a fraction
 * of the container). `minFraction` is capped at a quarter of the pair (see above), so the range
 * is the same whether the container is narrow or wide. */
export function clampGroupResizeDelta(rawDelta: number, startSizeA: number, startSizeB: number, minFraction: number): number {
  const pairTotal = startSizeA + startSizeB;
  const effectiveMinFraction = Math.min(minFraction, pairTotal * MAX_FLOOR_SHARE_OF_PAIR);
  // A group already under the floor (it was dragged there while the window was
  // narrower, or the sidebar was open) is not pushed up to it: the floor only
  // stops a group from getting smaller than it started. Clamping to the floor
  // outright made the first pointermove throw the handle to the floor's
  // position before it began to follow the pointer.
  const low = Math.min(effectiveMinFraction, startSizeA) - startSizeA;
  const high = startSizeB - Math.min(effectiveMinFraction, startSizeB);
  return Math.max(low, Math.min(high, rawDelta));
}

/**
 * Drag for a handle between two adjacent tab groups — sibling of
 * `usePanelDrag`/`useSplitDrag`, but working in fraction space (0..1) over
 * the whole `sizes` array instead of a single pixel value, and mutating the
 * container's CSS custom properties directly during the drag instead of
 * going through React state. That's what lets a resize run at zero React
 * renders per frame: the panel layer's `left`/`width` are `calc()`
 * expressions over `--g{i}-frac`/`--g{i}-cum`, so the browser recomputes
 * them on its own the instant the custom properties change, no re-render
 * needed until `onCommit` lands the final sizes on pointer up (same
 * drag-end-only persistence as `useSessionDock`'s dock resize).
 *
 * Only the two groups adjacent to the dragged handle ever change — sizes
 * before the handle keep their absolute values, and every cumulative sum
 * past the handle's right-hand group is unchanged too (what one group gives
 * up, its neighbor gains, so the running total past both is identical).
 */
export function useGroupSizeDrag(sizes: number[], containerRef: React.RefObject<HTMLElement | null>, onCommit: (sizes: number[]) => void) {
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const draggingRef = useRef(false);

  const startDrag = useCallback(
    (index: number) =>
      (event: React.PointerEvent) => {
        const container = containerRef.current;
        const containerWidth = container?.clientWidth ?? 0;
        if (!container || containerWidth === 0) return;
        // Rebound to a non-null local — TS doesn't carry the narrowing above
        // into the nested `onMove`/`onUp` closures below.
        const el = container;

        event.preventDefault();
        draggingRef.current = true;
        setDraggingIndex(index);

        const startX = event.clientX;
        const startSizeA = sizes[index];
        const startSizeB = sizes[index + 1];
        const cumBeforeA = sizes.slice(0, index).reduce((sum, size) => sum + size, 0);
        const minFraction = MIN_GROUP_PX / containerWidth;
        let nextSizeA = startSizeA;
        let nextSizeB = startSizeB;

        function onMove(moveEvent: PointerEvent): void {
          if (!draggingRef.current) return;
          const rawDelta = (moveEvent.clientX - startX) / containerWidth;
          const delta = clampGroupResizeDelta(rawDelta, startSizeA, startSizeB, minFraction);
          nextSizeA = startSizeA + delta;
          nextSizeB = startSizeB - delta;
          el.style.setProperty(`--g${index}-frac`, String(nextSizeA));
          el.style.setProperty(`--g${index + 1}-frac`, String(nextSizeB));
          el.style.setProperty(`--g${index + 1}-cum`, String(cumBeforeA + nextSizeA));
        }

        function onUp(): void {
          draggingRef.current = false;
          setDraggingIndex(null);
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          onCommit(sizes.map((size, i) => (i === index ? nextSizeA : i === index + 1 ? nextSizeB : size)));
        }

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      },
    [sizes, containerRef, onCommit],
  );

  return { draggingIndex, startDrag };
}
