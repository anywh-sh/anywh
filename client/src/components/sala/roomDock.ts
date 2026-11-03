import type { ReactNode } from "react";
import type { DockPaneKind } from "@/hooks/tabs/useSessionDock";

/** The panes of the session dock that belong to a room: one agent's
 * conversation, and what the room says about itself. */
export type RoomPaneKind = "agent" | "about";

/**
 * What a room is given to draw its own panes in the tab's dock. The room owns
 * what the panes show (its agents, their handlers); the dock owns the column
 * they stand in (the width, the stack, maximize, hiding). `null` where there
 * is no dock (compact windows, iOS): the room then keeps one panel of its own.
 */
export interface RoomDock {
  /** What is open in the column, top to bottom — the room's panes and the others. */
  panes: readonly DockPaneKind[];
  maximized: DockPaneKind | null;
  /** Each of these brings back a hidden side panel: they answer a request to see something. */
  open: (kind: RoomPaneKind) => void;
  toggle: (kind: RoomPaneKind) => void;
  close: (kind: RoomPaneKind) => void;
  toggleMaximized: (kind: RoomPaneKind) => void;
  /** The column itself, with `panes` as the content of the room's panes. */
  render: (panes: Partial<Record<RoomPaneKind, ReactNode>>) => ReactNode;
}
