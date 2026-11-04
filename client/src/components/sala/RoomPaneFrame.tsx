import type { ReactNode } from "react";
import { SalaPane } from "@/components/sala/SalaPane";
import { SalaSidePanel } from "@/components/sala/SalaSidePanel";
import { PaneHeaderButtons } from "@/components/shell/SessionPanel";

/** What holds a room's pane: a pane of the session dock, or — where there is no
 * dock — a panel of the room's own. */
export type RoomPaneShell = { kind: "side" } | { kind: "dock"; maximized: boolean; onToggleMaximized: () => void };

interface RoomPaneFrameProps {
  shell: RoomPaneShell;
  mark: ReactNode;
  title: string;
  titlePending?: boolean;
  subtitle: string;
  kind: string;
  footer?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

/** `SalaPane` in whichever shell the room has: the controls at its header's end
 * are the dock's (maximize, close) or the panel's own (close). */
export function RoomPaneFrame({ shell, onClose, ...pane }: RoomPaneFrameProps) {
  if (shell.kind === "side") return <SalaSidePanel {...pane} onClose={onClose} />;
  return <SalaPane {...pane} onClose={onClose} headerActions={<PaneHeaderButtons maximized={shell.maximized} onToggleMaximized={shell.onToggleMaximized} onClose={onClose} />} />;
}
