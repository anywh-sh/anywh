const STORAGE_KEY = "anywh:font-size";

/**
 * Tailwind v4's built-in `--text-*` scale (rem, at a 16px root) — mirrored
 * here so overriding these together scales every step relative to the
 * others exactly the way Tailwind's own defaults do, instead of picking
 * arbitrary numbers per size. Only the sizes this codebase actually uses
 * (`grep -roh 'text-(xs|sm|base|lg|xl|2xl|3xl)'`) plus the two neighbors
 * Tailwind ships by default, in case a future component reaches for one.
 *
 * Deliberately never touches `--spacing` or the root font-size: this
 * setting is about the size of text, not everything a `rem` reaches
 * (padding, gaps, dialog width, icon size) — the first cut of this feature
 * scaled the root font-size directly, and increasing it made every dialog
 * grow along with the text, which wasn't the ask.
 */
const TEXT_SCALE_REM: Record<string, number> = {
  xs: 0.75,
  sm: 0.875,
  base: 1,
  lg: 1.125,
  xl: 1.25,
  "2xl": 1.5,
  "3xl": 1.875,
};

const ROOT_PX = 16;
/** `text-sm` is the app's dominant body text size (chat messages, most
 * labels), so it's the one this setting exposes directly — same idea as
 * VS Code's `editor.fontSize`, a single number the rest of the scale
 * follows proportionally. */
const BASE_SM_PX = TEXT_SCALE_REM.sm * ROOT_PX; // 14 — Tailwind's own default

export const DEFAULT_FONT_SIZE = 15;
export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 20;
export const FONT_SIZE_STEP = 1;

function clamp(value: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, value));
}

function readStoredSize(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_FONT_SIZE;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clamp(parsed) : DEFAULT_FONT_SIZE;
  } catch {
    return DEFAULT_FONT_SIZE;
  }
}

/** Device-local only — unlike theme, this never goes through a profile's
 * relay, so there's nothing to sync and no per-profile override. */
export function applyFontSize(px: number): void {
  const ratio = px / BASE_SM_PX;
  const root = document.documentElement.style;
  for (const [key, rem] of Object.entries(TEXT_SCALE_REM)) {
    root.setProperty(`--text-${key}`, `${rem * ROOT_PX * ratio}px`);
  }
  // For the chrome text that's hand-tuned in raw px (`text-[10.5px]` and
  // friends — the sidebar's labels/timestamps, below the smallest named
  // step) instead of the named scale above: those multiply their own literal
  // by this ratio via `calc()` rather than getting a named step each, so the
  // setting still reaches them without inventing a token per one-off size.
  root.setProperty("--font-scale-ratio", String(ratio));
  // The same setting as a multiplier of the DEFAULT size rather than of
  // Tailwind's 14px base: 1 at the default, so chrome measured in raw px (the
  // sidebar, the strip, the composer) is exactly that size until the user
  // moves the setting.
  root.setProperty("--chrome-scale", String(px / DEFAULT_FONT_SIZE));
}

let size = readStoredSize();
const listeners = new Set<() => void>();

export function readFontSize(): number {
  return size;
}

export function writeFontSize(next: number): void {
  const clamped = clamp(next);
  if (clamped === size) return;
  size = clamped;
  localStorage.setItem(STORAGE_KEY, String(clamped));
  applyFontSize(clamped);
  for (const listener of listeners) listener();
}

export function subscribeFontSize(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
