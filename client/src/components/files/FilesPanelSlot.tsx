import { lazy, Suspense } from "react";
import type { useFileTabs } from "@/hooks/tabs/useFileTabs";
import type { Profile } from "@/lib/profiles/profiles";

// react-markdown/rehype-highlight/the code viewer's virtualizer only enter
// the bundle if/when the user actually opens the files pane — same reason
// `TerminalPanelSlot` lazily imports `TerminalPanel`.
const FilesPanel = lazy(() => import("@/components/files/FilesPanel").then((mod) => ({ default: mod.FilesPanel })));

interface FilesPanelSlotProps {
  profile: Profile;
  chatSessionId: string;
  maximized: boolean;
  fileTabs: ReturnType<typeof useFileTabs>;
  onToggleMaximized: () => void;
  onClose: () => void;
  onOpenTerminal: (path: string) => void;
}

/**
 * Lightweight wrapper around the heavy `FilesPanel` content. `SessionDock`
 * decides sizing/animation/whether this even mounts (see comment there) —
 * this component only fills whatever space it's given.
 */
export function FilesPanelSlot({ profile, chatSessionId, maximized, fileTabs, onToggleMaximized, onClose, onOpenTerminal }: FilesPanelSlotProps) {
  return (
    <Suspense fallback={<div className="h-full bg-bg-sidebar" />}>
      <FilesPanel
        profile={profile}
        chatSessionId={chatSessionId}
        maximized={maximized}
        fileTabs={fileTabs}
        onToggleMaximized={onToggleMaximized}
        onClose={onClose}
        onOpenTerminal={onOpenTerminal}
      />
    </Suspense>
  );
}
