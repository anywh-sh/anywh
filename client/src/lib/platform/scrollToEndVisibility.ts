/** Within this many px of the end the conversation counts as "at the end". */
const AT_END_PX = 4;
const MIN_SHOW_DISTANCE_PX = 240;

/**
 * Hysteresis for the "jump to end" arrow. It shows once the user is far from
 * the end (half a viewport, never less than 240px, so a few pixels of slack
 * don't flash it) and hides only on actually getting back to the end; in
 * between it keeps whatever it was doing.
 */
export function nextScrollToEndVisible(
  previous: boolean,
  metrics: { distanceFromEnd: number; viewportHeight: number },
): boolean {
  const showAbove = Math.max(MIN_SHOW_DISTANCE_PX, metrics.viewportHeight * 0.5);
  if (metrics.distanceFromEnd > showAbove) return true;
  if (metrics.distanceFromEnd <= AT_END_PX) return false;
  return previous;
}
