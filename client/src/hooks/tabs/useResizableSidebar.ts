import { useCallback, useRef, useState } from "react";

const MIN_WIDTH = 220;
const MAX_WIDTH = 420;
const DEFAULT_WIDTH = 280;
const COLLAPSED_STORAGE_KEY = "anywh:sidebar-collapsed";
const WIDTH_STORAGE_KEY = "anywh:sidebar-width";

function readInitialCollapsed(): boolean {
  return localStorage.getItem(COLLAPSED_STORAGE_KEY) === "true";
}

function readInitialWidth(): number {
  const raw = Number(localStorage.getItem(WIDTH_STORAGE_KEY));
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, raw));
}

export interface ResizableSidebar {
  /** Largura efetiva em px — 0 quando colapsada, sem depender de regra CSS separada. */
  width: number;
  collapsed: boolean;
  toggleCollapsed: () => void;
  startDrag: (event: React.PointerEvent) => void;
}

export function useResizableSidebar(): ResizableSidebar {
  const [width, setWidth] = useState(readInitialWidth);
  const [collapsed, setCollapsed] = useState(readInitialCollapsed);
  const draggingRef = useRef(false);

  const startDrag = useCallback(
    (event: React.PointerEvent) => {
      if (collapsed) return;
      event.preventDefault();
      draggingRef.current = true;

      const startX = event.clientX;
      const startWidth = width;

      function onMove(moveEvent: PointerEvent): void {
        if (!draggingRef.current) return;
        const next = startWidth + (moveEvent.clientX - startX);
        setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)));
      }

      function onUp(): void {
        draggingRef.current = false;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setWidth((value) => {
          localStorage.setItem(WIDTH_STORAGE_KEY, String(value));
          return value;
        });
      }

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [collapsed, width],
  );

  const toggleCollapsed = useCallback(() => {
    setCollapsed((value) => {
      const next = !value;
      localStorage.setItem(COLLAPSED_STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  return { width: collapsed ? 0 : width, collapsed, toggleCollapsed, startDrag };
}
