import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

/** How much the "canvas" (the whole agent screen) slides right when the
 * sessions drawer opens — the same fraction (~72% of a 375pt iPhone) from
 * the prototype validated with the user. The sidebar behind it
 * uses this same value as its own width, not the full screen — see `MobileShell`. */
export const REVEAL_PUSH_PX = 268;

/** Minimum offset, in px, for a still-closed drag to "commit" to the
 * gesture of opening the drawer. Asymmetric on purpose (see
 * `OPEN_ABANDON_RATIO`): easy to abandon (favors scroll), hard to commit
 * (avoids opening on its own during a vertical/diagonal scroll). */
const OPEN_COMMIT_THRESHOLD = 24;
const OPEN_COMMIT_RATIO = 2; // dx needs to be 2x bigger than dy to open
const OPEN_ABANDON_THRESHOLD = 10;
const OPEN_ABANDON_RATIO = 1; // dy only needs to match dx to abandon

export interface RevealDrawerHandle {
  open: boolean;
  canvasRef: RefObject<HTMLDivElement | null>;
  openDrawer: () => void;
  closeDrawer: () => void;
  toggleDrawer: () => void;
  /** On the closed canvas, starts observing any drag (not just near the
   * edge) — only actually starts moving the canvas after the movement
   * proves to be mostly horizontal to the right (see
   * `OPEN_COMMIT_THRESHOLD`), so it doesn't fight the log's vertical scroll. */
  onCanvasPointerDown: (event: ReactPointerEvent) => void;
  /** On the blocker (visible only when the drawer is open), any point
   * starts the drag — covers both "drag to close" and "tap to close" (a
   * tap with no movement counts as closing). */
  onBlockerPointerDown: (event: ReactPointerEvent) => void;
}

/**
 * "Reveal" mechanism for the sessions drawer on iOS (inspired by
 * the Claude app): instead of an overlay with a scrim over the content, the whole
 * agent screen slides to the right — gaining a subtle border, rounded
 * corners, and gradually losing opacity as it slides — and the
 * sidebar appears behind it. The live drag manipulates the DOM directly via ref
 * (no re-render per pixel); only the `open` state toggles the CSS's
 * `.pushed` class, which animates to the settled state.
 *
 * Real finding from testing on a physical device: a drag that starts inside an
 * area with its own scroll (vertical log, horizontal code block) can
 * get "stolen" by WebKit's native scroll mid-gesture — when
 * that happens, the browser fires `pointercancel`, not `pointerup`. Without
 * handling this separately, the listeners were never removed and the canvas got
 * stuck in an intermediate state (only a tap, via `onBlockerPointerDown`,
 * could "unstick" it). Every `pointerup` below has a sibling `pointercancel`
 * that does the same cleanup.
 */
export function useRevealDrawer(): RevealDrawerHandle {
  const [open, setOpen] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);

  const applyProgress = useCallback((t: number) => {
    const el = canvasRef.current;
    if (!el) return;
    const progress = t / REVEAL_PUSH_PX;
    el.style.transform = `translateX(${t}px)`;
    el.style.borderRadius = `${progress * 30}px`;
    // Same tokens the settled state uses (`.mobile-canvas.pushed`,
    // index.css) — `var()` resolves against the element, so an inline style
    // can reference them and the drag can't drift from the CSS anymore.
    el.style.boxShadow = t > 4 ? "-18px 26px 60px -24px var(--shadow-color)" : "none";
    el.style.opacity = String(1 - progress * 0.45);
    el.style.borderColor = `color-mix(in srgb, var(--glass-tint) ${String(progress * 16)}%, transparent)`;
  }, []);

  const clearInlineStyle = useCallback(() => {
    const el = canvasRef.current;
    if (!el) return;
    el.style.transform = "";
    el.style.borderRadius = "";
    el.style.boxShadow = "";
    el.style.opacity = "";
    el.style.borderColor = "";
  }, []);

  const openDrawer = useCallback(() => setOpen(true), []);
  const closeDrawer = useCallback(() => setOpen(false), []);
  const toggleDrawer = useCallback(() => setOpen((value) => !value), []);

  /** "Committed" drag — used both to close (from the
   * blocker, always active right away) and, after the threshold, to
   * open. */
  const beginDrag = useCallback(
    (startEvent: { clientX: number; clientY: number }, base: number) => {
      const startX = startEvent.clientX;
      let moved = false;
      let settled = false;
      const el = canvasRef.current;
      if (el) el.style.transition = "none";

      function cleanup(): void {
        document.removeEventListener("pointermove", handleMove);
        document.removeEventListener("pointerup", handleUp);
        document.removeEventListener("pointercancel", handleCancel);
        if (el) el.style.transition = "";
      }

      function handleMove(event: PointerEvent): void {
        const dx = event.clientX - startX;
        if (Math.abs(dx) > 3) moved = true;
        event.preventDefault();
        applyProgress(Math.max(0, Math.min(REVEAL_PUSH_PX, base + dx)));
      }

      function handleUp(event: PointerEvent): void {
        if (settled) return;
        settled = true;
        cleanup();
        clearInlineStyle();

        const dx = event.clientX - startX;
        const finalT = Math.max(0, Math.min(REVEAL_PUSH_PX, base + dx));
        if (!moved) {
          if (base === REVEAL_PUSH_PX) closeDrawer();
          else openDrawer();
        } else if (finalT > REVEAL_PUSH_PX * 0.42) {
          openDrawer();
        } else {
          closeDrawer();
        }
      }

      /** The gesture got "stolen" by native scroll (WebKit sends cancel, not
       * up) — there's no way to know the user's intent in this case, so it just
       * goes back to the current settled state (doesn't decide open/close). */
      function handleCancel(): void {
        if (settled) return;
        settled = true;
        cleanup();
        clearInlineStyle();
      }

      document.addEventListener("pointermove", handleMove, { passive: false });
      document.addEventListener("pointerup", handleUp);
      document.addEventListener("pointercancel", handleCancel);
    },
    [applyProgress, clearInlineStyle, openDrawer, closeDrawer],
  );

  /** Closed: observes any drag on the main screen, without interfering
   * (no preventDefault, no touching the canvas) until the movement proves to be
   * mostly horizontal to the right — only then do we "commit" to the
   * gesture of opening via `beginDrag`. Until then, vertical log scroll and taps
   * on buttons keep working normally. The commit threshold is
   * intentionally higher/stricter than the abandon one — favors scroll. */
  const onCanvasPointerDown = useCallback(
    (startEvent: ReactPointerEvent) => {
      if (open) return;
      const startX = startEvent.clientX;
      const startY = startEvent.clientY;
      let done = false;

      function stop(): void {
        document.removeEventListener("pointermove", handlePendingMove);
        document.removeEventListener("pointerup", handlePendingUp);
        document.removeEventListener("pointercancel", handlePendingUp);
      }

      function handlePendingMove(event: PointerEvent): void {
        if (done) return;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (dx > OPEN_COMMIT_THRESHOLD && dx > Math.abs(dy) * OPEN_COMMIT_RATIO) {
          done = true;
          stop();
          // Restarts the "real" drag from here, already committed
          // — the small delta traveled up to the threshold is imperceptible.
          beginDrag(event, 0);
        } else if (Math.abs(dy) > OPEN_ABANDON_THRESHOLD && Math.abs(dy) > dx * OPEN_ABANDON_RATIO) {
          // Mostly vertical movement — it's log scroll, not the
          // opening gesture. Bails out without ever having interfered.
          done = true;
          stop();
        }
      }

      function handlePendingUp(): void {
        if (done) return;
        done = true;
        stop();
      }

      document.addEventListener("pointermove", handlePendingMove, { passive: true });
      document.addEventListener("pointerup", handlePendingUp);
      document.addEventListener("pointercancel", handlePendingUp);
    },
    [open, beginDrag],
  );

  const onBlockerPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      event.stopPropagation();
      beginDrag(event, REVEAL_PUSH_PX);
    },
    [beginDrag],
  );

  return { open, canvasRef, openDrawer, closeDrawer, toggleDrawer, onCanvasPointerDown, onBlockerPointerDown };
}
