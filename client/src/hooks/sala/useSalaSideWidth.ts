import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { DEFAULT_FONT_SIZE, readFontSize, subscribeFontSize } from "@/lib/fontSize";

/** 384px of panel plus the divider's own pixel: the width the panel always had. */
export const SALA_SIDE_DEFAULT_WIDTH = 385;
/** The panel never gets narrower than its original width. */
export const SALA_SIDE_MIN_WIDTH = SALA_SIDE_DEFAULT_WIDTH;
export const SALA_SIDE_STORAGE_KEY = "anywh:sala-side-width";
/** How far one arrow key press moves the panel's edge. */
const KEY_STEP = 16;

// What a conversation's text can use, from `MessageLog`: a column capped at
// `680px * --chrome-scale`, inside the scroller's `px-4` and its stable
// scrollbar gutter on both edges (8px each, `.scrollbar-thin`). Past this a
// wider panel only adds empty margin around the principal's conversation.
const CHAT_TEXT_PX = 680;
const CHAT_CHROME_PX = 2 * 16 + 2 * 8;
const DIVIDER_PX = 1;

/** The panel's width when the conversation in it reaches its widest text. */
export function salaSideChatWidth(chromeScale: number): number {
  return Math.round(CHAT_TEXT_PX * chromeScale) + CHAT_CHROME_PX + DIVIDER_PX;
}

/** The widest the panel may be: no wider than a conversation can use, nor
 * than half the window; never below the minimum. */
export function salaSideMaxWidth(viewportWidth: number, chromeScale = 1): number {
  return Math.max(SALA_SIDE_MIN_WIDTH, Math.min(salaSideChatWidth(chromeScale), Math.floor(viewportWidth / 2)));
}

export function clampSalaSideWidth(width: number, max: number): number {
  if (!Number.isFinite(width)) return SALA_SIDE_DEFAULT_WIDTH;
  return Math.min(Math.max(SALA_SIDE_MIN_WIDTH, max), Math.max(SALA_SIDE_MIN_WIDTH, Math.round(width)));
}

/** A stored width, if it is one at all; the limits apply when it is drawn. */
export function parseSalaSideWidth(raw: string | null): number {
  if (raw === null || raw.trim() === "") return SALA_SIDE_DEFAULT_WIDTH;
  const value = Number(raw);
  if (!Number.isFinite(value)) return SALA_SIDE_DEFAULT_WIDTH;
  return Math.max(SALA_SIDE_MIN_WIDTH, Math.round(value));
}

// The width the person asked for, shared by every room's panel (the setting
// is global, and only one room is on screen at a time). What is drawn is this
// clamped to the window, so shrinking the window and growing it back returns
// the panel to the width that was chosen.
let preferred: number | null = null;
const listeners = new Set<() => void>();

function getPreferred(): number {
  if (preferred === null) preferred = parseSalaSideWidth(localStorage.getItem(SALA_SIDE_STORAGE_KEY));
  return preferred;
}

function setPreferred(width: number): void {
  const next = parseSalaSideWidth(String(width));
  localStorage.setItem(SALA_SIDE_STORAGE_KEY, String(next));
  if (next === preferred) return;
  preferred = next;
  for (const listener of listeners) listener();
}

function subscribePreferred(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function subscribeViewport(listener: () => void): () => void {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
}

const getViewportWidth = (): number => window.innerWidth;

/** The rules outside the panel that have to line up with its edge (the
 * plane's frame and the status bar's rule, at the end of `sala.css`). */
const OUTSIDE = "[data-plane-frame], [data-status-bar]";

/**
 * Draws `width`. The panel gets a plain `width`, which nothing inherits; the
 * two rules outside it get `--sala-side-w`. Never on the document root: a
 * custom property there restyles the whole page, and `<html style>` is
 * watched by the theme observer, which re-renders the whole shell; measured,
 * that made a drag drop most of its frames.
 */
function publish(panel: HTMLElement | null, width: number): void {
  const value = `${width}px`;
  if (panel) panel.style.width = value;
  for (const el of document.querySelectorAll<HTMLElement>(OUTSIDE)) el.style.setProperty("--sala-side-w", value);
}

export interface SalaSideWidth {
  /** The width to draw, in px (divider included). */
  width: number;
  min: number;
  max: number;
  /** A drag is under way: the handle stays lit for it, wherever the pointer is. */
  dragging: boolean;
  gripProps: {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
    onKeyDown: (event: React.KeyboardEvent) => void;
    onDoubleClick: () => void;
  };
}

/**
 * The room side panel's width: dragged from its left edge, persisted in
 * `localStorage`, clamped to the window and to what a conversation can use.
 * A drag writes the width straight to the DOM once per frame and only goes
 * through React (and storage) when it ends.
 */
export function useSalaSideWidth(panelRef: React.RefObject<HTMLElement | null>): SalaSideWidth {
  const chosen = useSyncExternalStore(subscribePreferred, getPreferred);
  const viewport = useSyncExternalStore(subscribeViewport, getViewportWidth);
  const fontSize = useSyncExternalStore(subscribeFontSize, readFontSize);
  const max = salaSideMaxWidth(viewport, fontSize / DEFAULT_FONT_SIZE);
  const width = clampSalaSideWidth(chosen, max);
  const [dragging, setDragging] = useState(false);
  const endDrag = useRef<(() => void) | null>(null);

  useLayoutEffect(() => publish(panelRef.current, width), [panelRef, width]);
  // A panel that goes away mid-drag must not leave its listeners behind.
  useLayoutEffect(() => () => endDrag.current?.(), []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      endDrag.current?.();
      const grip = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      let next = width;
      let frame = 0;

      function draw(): void {
        frame = 0;
        publish(panelRef.current, next);
        grip.setAttribute("aria-valuenow", String(next));
      }
      function finish(): void {
        endDrag.current = null;
        if (frame !== 0) cancelAnimationFrame(frame);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onEnd);
        window.removeEventListener("pointercancel", onEnd);
        grip.removeEventListener("lostpointercapture", onEnd);
        if (grip.hasPointerCapture?.(pointerId)) grip.releasePointerCapture(pointerId);
        // Focus a press gave the handle would light it up on the next key press.
        if (document.activeElement === grip) grip.blur();
        draw();
        setDragging(false);
        setPreferred(next);
      }
      function onMove(move: PointerEvent): void {
        if (move.pointerId !== pointerId) return;
        // A mouse with no button down: the release happened where this never heard of it.
        if (move.pointerType === "mouse" && move.buttons === 0) {
          finish();
          return;
        }
        // The edge sits on the panel's left: moving it left widens the panel.
        next = clampSalaSideWidth(width - (move.clientX - startX), salaSideMaxWidth(window.innerWidth, readFontSize() / DEFAULT_FONT_SIZE));
        // One write per frame, however many moves the frame saw.
        if (frame === 0) frame = requestAnimationFrame(draw);
      }
      function onEnd(end: PointerEvent): void {
        if (end.pointerId === pointerId) finish();
      }

      // Keeps every move and the release coming to the handle even once the
      // clamp leaves it out from under the pointer, or the pointer leaves the window.
      try {
        grip.setPointerCapture(pointerId);
      } catch {
        // Not a live pointer (a synthetic event): the window listeners still hear it.
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onEnd);
      window.addEventListener("pointercancel", onEnd);
      grip.addEventListener("lostpointercapture", onEnd);
      endDrag.current = finish;
      setDragging(true);
    },
    [panelRef, width],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const next =
        event.key === "ArrowLeft" ? width + KEY_STEP
        : event.key === "ArrowRight" ? width - KEY_STEP
        : event.key === "Home" ? SALA_SIDE_MIN_WIDTH
        : event.key === "End" ? max
        : null;
      if (next === null) return;
      event.preventDefault();
      setPreferred(clampSalaSideWidth(next, max));
    },
    [width, max],
  );

  const onDoubleClick = useCallback(() => setPreferred(SALA_SIDE_DEFAULT_WIDTH), []);

  return { width, min: SALA_SIDE_MIN_WIDTH, max, dragging, gripProps: { onPointerDown, onKeyDown, onDoubleClick } };
}
