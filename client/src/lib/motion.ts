/** The app's one animation duration (`--motion-fast`, in `index.css`), in
 * milliseconds. For the rare case where script has to wait for a CSS
 * transition to finish — a panel that gives its space back once it has
 * slid out — and so must not hard-code a number that the stylesheet owns.
 * Falls back to the token's own value where there are no styles to read. */
export function motionFastMs(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--motion-fast").trim();
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return 120;
  return raw.endsWith("ms") ? value : value * 1000;
}
