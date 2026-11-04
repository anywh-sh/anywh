import { useCallback, useRef, useState } from "react";
import type { RoomDock, RoomPaneKind } from "@/components/sala/roomDock";

const ROOM_PANES: readonly RoomPaneKind[] = ["agent", "about"];
const isRoomPane = (kind: string): kind is RoomPaneKind => (ROOM_PANES as readonly string[]).includes(kind);

export interface RoomPanes {
  agentOpen: boolean;
  aboutOpen: boolean;
  /** The room's pane that was opened last, if any is open: what Esc closes. */
  last: RoomPaneKind | null;
  open: (kind: RoomPaneKind) => void;
  toggle: (kind: RoomPaneKind) => void;
  close: (kind: RoomPaneKind) => void;
  closeAll: () => void;
}

/**
 * Which of a room's panes are open. With a dock that is the dock's answer
 * (the panes are in its column, and it keeps their order); without one
 * (compact windows, iOS) the room holds one panel at a time, so opening a
 * pane replaces the one that was open. The callbacks are stable: they read
 * the dock of the latest render.
 */
export function useRoomPanes(dock: RoomDock | null): RoomPanes {
  const [inline, setInline] = useState<RoomPaneKind | null>(null);
  const dockRef = useRef(dock);
  dockRef.current = dock;

  const open = useCallback((kind: RoomPaneKind) => {
    if (dockRef.current) dockRef.current.open(kind);
    else setInline(kind);
  }, []);
  const toggle = useCallback((kind: RoomPaneKind) => {
    if (dockRef.current) dockRef.current.toggle(kind);
    else setInline((current) => (current === kind ? null : kind));
  }, []);
  const close = useCallback((kind: RoomPaneKind) => {
    if (dockRef.current) dockRef.current.close(kind);
    else setInline((current) => (current === kind ? null : current));
  }, []);
  const closeAll = useCallback(() => {
    if (dockRef.current) for (const kind of ROOM_PANES) dockRef.current.close(kind);
    else setInline(null);
  }, []);

  const inDock = dock ? dock.panes.filter(isRoomPane) : [];
  const agentOpen = dock ? inDock.includes("agent") : inline === "agent";
  const aboutOpen = dock ? inDock.includes("about") : inline === "about";
  const last = dock ? (inDock[inDock.length - 1] ?? null) : inline;
  return { agentOpen, aboutOpen, last, open, toggle, close, closeAll };
}
