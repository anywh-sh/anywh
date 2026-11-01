/** Where a horizontal scrollbar's thumb sits, in pixels along its track.
 * `null` when there is nothing to scroll (the content fits), which is also
 * when the bar should not be drawn at all. */
export interface ScrollThumb {
  left: number;
  width: number;
}

/** The thumb is never thinner than this, however many tabs there are — a
 * sliver under a few pixels can't be seen or grabbed. */
const MIN_THUMB_PX = 24;

export function scrollThumb(scrollLeft: number, scrollWidth: number, clientWidth: number): ScrollThumb | null {
  if (clientWidth <= 0 || scrollWidth <= clientWidth + 1) return null;
  const width = Math.min(clientWidth, Math.max(MIN_THUMB_PX, (clientWidth / scrollWidth) * clientWidth));
  const maxScroll = scrollWidth - clientWidth;
  const progress = Math.min(1, Math.max(0, scrollLeft / maxScroll));
  return { left: progress * (clientWidth - width), width };
}

/** The `scrollLeft` that puts the thumb's left edge at `thumbLeft` — the
 * inverse of `scrollThumb`, for dragging the thumb. */
export function scrollLeftForThumb(thumbLeft: number, scrollWidth: number, clientWidth: number): number {
  const thumb = scrollThumb(0, scrollWidth, clientWidth);
  if (!thumb) return 0;
  const room = clientWidth - thumb.width;
  if (room <= 0) return 0;
  return Math.min(1, Math.max(0, thumbLeft / room)) * (scrollWidth - clientWidth);
}
