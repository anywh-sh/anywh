/** An animation duration token from `index.css` (`--motion-fast`,
 * `--motion-medium`), in milliseconds. For the rare case where script has to
 * wait for a CSS transition to finish — a panel that drops its divider once it
 * has closed — and so must not hard-code a number that the stylesheet owns.
 * Falls back to `fallback` where there are no styles to read. */
function motionMs(token: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  return raw.endsWith("ms") ? value : value * 1000;
}

export const motionFastMs = (): number => motionMs("--motion-fast", 120);
export const motionMediumMs = (): number => motionMs("--motion-medium", 200);

/** The timing of a panel opening and closing — the sidebar's, and whatever
 * moves the way it does: the medium duration on the shared easing, and no
 * transition under reduced motion. Pair it with the `transition-*` of the
 * properties that move. */
export const PANEL_MOTION = "duration-(--motion-medium) ease-(--motion-ease) motion-reduce:transition-none";
