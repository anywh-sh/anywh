import { useCallback, useRef, useState } from "react";

/** Drag for the horizontal divider between two stacked panes in the same
 * dock column — same mechanics as `usePanelDrag`, but on the Y axis and in
 * ratio space (0..1) instead of pixels: the divider decides how the two
 * panes split *the column's own* current height, not an absolute size, so
 * the pointer delta is converted using the container's height measured at
 * drag start. */
export function useSplitDrag(
  splitRatio: number,
  onChange: (ratio: number) => void,
  containerRef: React.RefObject<HTMLElement | null>,
  onDragEnd?: () => void,
) {
  const [isDragging, setIsDragging] = useState(false);
  const draggingRef = useRef(false);

  const startDrag = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      const containerHeight = containerRef.current?.clientHeight ?? 0;
      if (containerHeight === 0) return;

      draggingRef.current = true;
      setIsDragging(true);

      const startY = event.clientY;
      const startRatio = splitRatio;

      function onMove(moveEvent: PointerEvent): void {
        if (!draggingRef.current) return;
        onChange(startRatio + (moveEvent.clientY - startY) / containerHeight);
      }

      function onUp(): void {
        draggingRef.current = false;
        setIsDragging(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        onDragEnd?.();
      }

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [splitRatio, onChange, containerRef, onDragEnd],
  );

  return { isDragging, startDrag };
}
