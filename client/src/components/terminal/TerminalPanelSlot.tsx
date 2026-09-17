import { lazy, Suspense } from "react";
import type { useTerminalTabs } from "@/hooks/tabs/useTerminalTabs";
import type { Profile } from "@/lib/profiles/profiles";

// xterm.js (+ addons) only enters the bundle if/when the user actually opens
// a terminal — the `lazy` lives here, not in the heavy content itself nor in
// App.tsx, so the heavy chunk only loads on the first real open.
const TerminalPanel = lazy(() =>
  import("@/components/terminal/TerminalPanel").then((mod) => ({ default: mod.TerminalPanel })),
);

interface TerminalPanelSlotProps {
  profile: Profile;
  chatSessionId: string;
  maximized: boolean;
  terminalTabs: ReturnType<typeof useTerminalTabs>;
  onToggleMaximized: () => void;
  onClose: () => void;
}

/**
 * Lightweight wrapper (no xterm.js import) around the heavy `TerminalPanel`
 * content. `SessionDock` decides sizing/animation/whether this even mounts
 * (see comment there) — this component only fills whatever space it's
 * given.
 */
export function TerminalPanelSlot({ profile, chatSessionId, maximized, terminalTabs, onToggleMaximized, onClose }: TerminalPanelSlotProps) {
  return (
    <Suspense fallback={<div className="h-full bg-bg-sidebar" />}>
      <TerminalPanel
        profile={profile}
        chatSessionId={chatSessionId}
        maximized={maximized}
        terminalTabs={terminalTabs}
        onToggleMaximized={onToggleMaximized}
        onClose={onClose}
      />
    </Suspense>
  );
}
