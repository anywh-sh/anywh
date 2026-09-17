import { useEffect, useRef } from "react";
import { PaneTabStrip } from "@/components/shell/PaneTabStrip";
import { SessionPanel } from "@/components/shell/SessionPanel";
import { TerminalView } from "@/components/terminal/TerminalView";
import type { useTerminalTabs } from "@/hooks/tabs/useTerminalTabs";
import { closeTerminal } from "@/lib/relay/relayClient";
import { resolveConnection } from "@/lib/profiles/connectionResolver";
import type { Profile } from "@/lib/profiles/profiles";
import { useDict } from "@/i18n";

interface TerminalPanelProps {
  profile: Profile;
  chatSessionId: string;
  maximized: boolean;
  terminalTabs: ReturnType<typeof useTerminalTabs>;
  onToggleMaximized: () => void;
  onClose: () => void;
}

/**
 * Terminal-specific content, plugged into the generic `SessionPanel` shell.
 * Only mounts while the chat tab that owns it is active AND the panel is
 * marked open (decided by the caller, see App.tsx) — this conditional
 * mount/unmount is what implements "switching sessions closes the panel on
 * its own, coming back reopens it the way it was": unmounting closes each
 * terminal tab's WS (the relay only detaches from tmux, never kills the
 * session because of it — see terminalSession.ts), remounting reconnects
 * and tmux redraws the screen on its own.
 *
 * All of the panel's terminal tabs stay mounted at the same time
 * (same trick as `TabGroupLayout.tsx`'s flat panel layer) — only the whole panel
 * connects/disconnects on entering/leaving focus, switching between
 * terminal tabs inside an already-open panel is instant, no reconnecting.
 * The number of tabs per panel tends to be small (a handful), so the cost
 * of keeping them all alive is low — quite different from keeping *every*
 * chat session's terminal alive, which is exactly what the conditional
 * mounting above avoids.
 */
export function TerminalPanel({
  profile,
  chatSessionId,
  maximized,
  terminalTabs,
  onToggleMaximized,
  onClose,
}: TerminalPanelProps) {
  const dict = useDict();
  const { tabs, activeTerminalId } = terminalTabs.getTabs(chatSessionId);
  const { addTerminal } = terminalTabs;
  /** `true` as soon as the list has had at least one tab — this is what
   * distinguishes "panel just opened, still empty" (seeds "Terminal 1")
   * from "had a tab, user closed the last one" (closes the panel). A single
   * effect, not two: the first version fired both in sequence in the same
   * pass — `addTerminal` already sets a synchronous flag before the new
   * state (`tabs`) has re-rendered, so a separate "close if empty" effect
   * would read `tabs.length` still as 0 and close the panel an instant
   * after opening (found while actually testing: opening always ended up
   * closing itself again). A single effect, driven by the real transition
   * of `tabs.length` between renders, avoids the race. */
  const hasHadTabsRef = useRef(false);
  /** Guards against StrictMode's dev-only double-invoke of this effect: on
   * mount, React fires it twice back to back before any state update from
   * the first call has actually re-rendered the component, so both
   * invocations still see `tabs.length === 0` — without this guard that
   * seeded two tabs ("Terminal 1" and "Terminal 2") instead of one, with the
   * second call's `addTerminal` left active (found while testing: the panel
   * always opened on "Terminal 2"). The ref is stable across both
   * invocations (same component instance), so the second one sees it
   * already flipped and skips. */
  const seededRef = useRef(false);
  useEffect(() => {
    if (tabs.length > 0) {
      hasHadTabsRef.current = true;
      return;
    }
    if (hasHadTabsRef.current) {
      onClose();
    } else if (!seededRef.current) {
      seededRef.current = true;
      addTerminal(chatSessionId);
    }
  }, [tabs.length, chatSessionId, onClose, addTerminal]);

  function handleCloseTerminal(terminalId: string): void {
    terminalTabs.closeTerminal(chatSessionId, terminalId);
    resolveConnection(profile)
      .then(({ host, port, token }) => closeTerminal(host, port, chatSessionId, terminalId, token))
      .catch((error: unknown) => {
        console.error("[anywh] failed to close terminal:", error);
      });
  }

  return (
    <SessionPanel
      maximized={maximized}
      onToggleMaximized={onToggleMaximized}
      onClose={onClose}
      headerExtra={
        <PaneTabStrip
          tabs={tabs}
          activeId={activeTerminalId}
          onSelect={(id) => terminalTabs.setActiveTerminal(chatSessionId, id)}
          onClose={handleCloseTerminal}
          onAdd={() => terminalTabs.addTerminal(chatSessionId)}
          addLabel={dict.panels.terminal.newTerminal}
        />
      }
    >
      <div className="relative h-full min-h-0">
        {tabs.map((tab) => (
          <div key={tab.id} className={tab.id === activeTerminalId ? "absolute inset-0" : "invisible absolute inset-0"}>
            <TerminalView profile={profile} chatSessionId={chatSessionId} terminalId={tab.id} cwd={tab.cwd} />
          </div>
        ))}
      </div>
    </SessionPanel>
  );
}
