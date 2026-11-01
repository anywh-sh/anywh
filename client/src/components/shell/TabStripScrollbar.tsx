import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { scrollLeftForThumb, scrollThumb, type ScrollThumb } from "@/lib/scrollThumb";

interface TabStripScrollbarProps {
  /** The strip that scrolls. Its native scrollbar is hidden: that one takes
   * height from the strip when it appears, which squeezes the tabs and
   * clips the profile rule on their top edge. */
  scrollerRef: RefObject<HTMLElement | null>;
  /** Changes whenever the tabs' widths may have — a title arriving, a tab
   * opened or closed — so the thumb is re-measured. */
  contentKey: unknown;
}

/**
 * A thin scrollbar drawn over the bottom edge of the tab strip. It is out of
 * the layout on purpose — an overlay, so showing or hiding it never moves a
 * tab — and only its thumb takes pointer events, so the strip underneath
 * stays clickable and draggable. Subtle at rest, brighter on hover and while
 * dragged.
 */
export function TabStripScrollbar({ scrollerRef, contentKey }: TabStripScrollbarProps) {
  const [thumb, setThumb] = useState<ScrollThumb | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startLeft: number } | null>(null);

  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const next = scrollThumb(el.scrollLeft, el.scrollWidth, el.clientWidth);
    setThumb((prev) => (prev?.left === next?.left && prev?.width === next?.width ? prev : next));
  }, [scrollerRef]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [scrollerRef, measure]);

  // The tabs changed width without the strip itself resizing.
  useEffect(measure, [measure, contentKey]);

  // Up, cancelled (a touch interrupted) or capture lost (the window blurred):
  // all end the drag, or the next move over the thumb would keep scrolling.
  function endDrag() {
    drag.current = null;
    setDragging(false);
  }

  if (!thumb) return null;

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 z-30 h-1.5">
      <div
        onPointerDown={(event) => {
          const el = scrollerRef.current;
          if (!el) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { startX: event.clientX, startLeft: thumb.left };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const el = scrollerRef.current;
          if (!drag.current || !el) return;
          el.scrollLeft = scrollLeftForThumb(drag.current.startLeft + event.clientX - drag.current.startX, el.scrollWidth, el.clientWidth);
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        className={cn(
          // 6px tall, drawn at half height at rest: scaling from the bottom
          // edge composites, where animating `height` would not.
          "pointer-events-auto absolute bottom-0 h-1.5 origin-bottom cursor-pointer transition-[transform,background-color]",
          dragging ? "scale-y-100 bg-text-faint" : "scale-y-50 bg-border hover:scale-y-100 hover:bg-text-faint",
        )}
        style={{ left: thumb.left, width: thumb.width }}
      />
    </div>
  );
}
