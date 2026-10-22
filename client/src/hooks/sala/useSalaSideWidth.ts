import { useCallback, useLayoutEffect, useSyncExternalStore } from "react";
import { usePanelDrag } from "@/hooks/tabs/usePanelDrag";
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

function setPreferred(width: number, persist: boolean): void {
  const next = parseSalaSideWidth(String(width));
  if (persist) localStorage.setItem(SALA_SIDE_STORAGE_KEY, String(next));
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

export interface SalaSideWidth {
  /** The width to draw, in px (divider included). */
  width: number;
  min: number;
  max: number;
  startDrag: (event: React.PointerEvent) => void;
  /** Arrow keys move the edge, Home/End jump to the limits. */
  onKeyDown: (event: React.KeyboardEvent) => void;
  /** Back to the default width. */
  reset: () => void;
}

/**
 * The room side panel's width: dragged from its left edge, persisted in
 * `localStorage`, clamped to the window and to what a conversation can use. It also publishes the width as
 * `--sala-side-w` on the document root, for the rules outside the panel that
 * have to line up with it (the plane's frame, the status bar's rule).
 */
export function useSalaSideWidth(): SalaSideWidth {
  const chosen = useSyncExternalStore(subscribePreferred, getPreferred);
  const viewport = useSyncExternalStore(subscribeViewport, getViewportWidth);
  const fontSize = useSyncExternalStore(subscribeFontSize, readFontSize);
  const max = salaSideMaxWidth(viewport, fontSize / DEFAULT_FONT_SIZE);
  const width = clampSalaSideWidth(chosen, max);

  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--sala-side-w", `${width}px`);
  }, [width]);

  const onChange = useCallback((next: number) => setPreferred(clampSalaSideWidth(next, salaSideMaxWidth(window.innerWidth, readFontSize() / DEFAULT_FONT_SIZE)), false), []);
  const onDragEnd = useCallback(() => setPreferred(getPreferred(), true), []);
  const { startDrag } = usePanelDrag(width, onChange, onDragEnd);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // The edge sits on the panel's left: moving it left widens the panel.
      const next =
        event.key === "ArrowLeft" ? width + KEY_STEP
        : event.key === "ArrowRight" ? width - KEY_STEP
        : event.key === "Home" ? SALA_SIDE_MIN_WIDTH
        : event.key === "End" ? max
        : null;
      if (next === null) return;
      event.preventDefault();
      setPreferred(clampSalaSideWidth(next, max), true);
    },
    [width, max],
  );

  const reset = useCallback(() => setPreferred(SALA_SIDE_DEFAULT_WIDTH, true), []);

  return { width, min: SALA_SIDE_MIN_WIDTH, max, startDrag, onKeyDown, reset };
}
