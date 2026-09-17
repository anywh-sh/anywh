import { useCallback, useRef, useState } from "react";
import { MIN_USABLE_CHAT_PX, MIN_WIDTH_WITH_FILES } from "@/hooks/tabs/useSessionDock";

/** Floor for a group's width, in px — below this a chat column stops being
 * usable once a dock sits at its own minimum next to it. Sized as the
 * dock's own floor with the files pane open plus a usable chat width (see
 * `useSessionDock.ts`'s `MIN_USABLE_CHAT_PX`), not just an arbitrary chat-only
 * number — a group can host a dock, so its own minimum has to account for one. */
export const MIN_GROUP_PX = MIN_WIDTH_WITH_FILES + MIN_USABLE_CHAT_PX;

// Real safety floor — just enough to keep a group from ever reaching exactly
// 0 (which would corrupt the virtualizer's height cache, same invariant
// `TabGroupLayout`'s `invisible`-not-`display:none` panels protect). Small
// on purpose: it only kicks in once `MIN_GROUP_PX` itself doesn't fit (see
// `clampGroupResizeDelta`), where the goal is a responsive drag, not landing
// on another aspirational number.
const ABSOLUTE_MIN_FRACTION = 0.08;

/** How much of `rawDelta` (the pointer's raw movement, in fraction-of-container
 * space) actually gets applied to the pair of adjacent groups sharing a
 * resize handle, clamped so neither group's fraction drops below
 * `minFraction` (in the common case, `MIN_GROUP_PX` converted to a fraction
 * of the container).
 *
 * `MIN_GROUP_PX` is an aspiration, not a hard requirement — on an ordinary
 * window, two groups splitting 1200-1600px don't leave room for two
 * 900px-wide groups at once (`minFraction * 2 > pairTotal`). Naively
 * clamping to `minFraction` there makes the lower bound land *above* the
 * upper one, and `Math.max(low, Math.min(high, raw))` with `low > high`
 * always returns `low` regardless of `raw` — every pointermove would
 * compute the identical forced delta no matter which direction (or how far)
 * the pointer actually moved, making the handle look completely
 * unresponsive. When the aspiration doesn't fit, this falls back to a much
 * smaller absolute floor instead, which still leaves real room to drag. */
export function clampGroupResizeDelta(rawDelta: number, startSizeA: number, startSizeB: number, minFraction: number): number {
  const pairTotal = startSizeA + startSizeB;
  const effectiveMinFraction = minFraction * 2 <= pairTotal ? minFraction : Math.min(ABSOLUTE_MIN_FRACTION, pairTotal / 2);
  return Math.max(effectiveMinFraction - startSizeA, Math.min(startSizeB - effectiveMinFraction, rawDelta));
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
