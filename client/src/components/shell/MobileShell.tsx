import type { CSSProperties, ReactNode } from "react";
import { MobileSidebar } from "@/components/shell/MobileSidebar";
import { MobileTopBar } from "@/components/shell/MobileTopBar";
import { REVEAL_PUSH_PX, useRevealDrawer } from "@/hooks/tabs/useRevealDrawer";
import { cn } from "@/lib/utils";
import type { Profile } from "@/lib/profiles/profiles";
import type { MergedSession } from "@/lib/format/sessionGrouping";

interface MobileShellProps {
  activeProfile: Profile;
  profiles: Profile[];
  onProfileChange: (profileId: string) => void;
  sessions: MergedSession[];
  sessionsLoading: boolean;
  sessionsError: boolean;
  onRetrySessions: () => void;
  selectedSession: string | null;
  runningSessions: Set<string>;
  backgroundJobSessions: Set<string>;
  onSelectSession: (session: MergedSession) => void;
  onRenameSession: (session: MergedSession, title: string) => void;
  onDeleteSession: (session: MergedSession) => void;
  onOpenSearch: () => void;
  title: string;
  connected: boolean;
  onNewConversation: () => void;
  children: ReactNode;
}

/**
 * The app's shell on iOS — replaces the desktop chrome (TitleBar +
 * resizable Sidebar/Sheet) with: a session sidebar always mounted behind
 * (`MobileSidebar`), and a "canvas" in front that carries the consolidated
 * top bar (`MobileTopBar`) + the chat content (`children`, the same
 * per-profile panels `App` already mounts for desktop). The canvas slides to
 * reveal the sidebar instead of an overlay with a scrim — see `useRevealDrawer`.
 */
export function MobileShell({
  activeProfile,
  profiles,
  onProfileChange,
  sessions,
  sessionsLoading,
  sessionsError,
  onRetrySessions,
  selectedSession,
  runningSessions,
  backgroundJobSessions,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onOpenSearch,
  title,
  connected,
  onNewConversation,
  children,
}: MobileShellProps) {
  const drawer = useRevealDrawer();

  return (
    <div
      className="relative min-h-0 flex-1 overflow-hidden bg-bg-sidebar"
      style={{ "--push": `${REVEAL_PUSH_PX}px` } as CSSProperties}
    >
      <MobileSidebar
        activeProfile={activeProfile}
        profiles={profiles}
        onProfileChange={onProfileChange}
        sessions={sessions}
        sessionsLoading={sessionsLoading}
        sessionsError={sessionsError}
        onRetrySessions={onRetrySessions}
        selectedSession={selectedSession}
        runningSessions={runningSessions}
        backgroundJobSessions={backgroundJobSessions}
        onSelectSession={(session) => {
          onSelectSession(session);
          drawer.closeDrawer();
        }}
        onRenameSession={onRenameSession}
        onDeleteSession={onDeleteSession}
        onOpenSearch={() => {
          onOpenSearch();
          drawer.closeDrawer();
        }}
      />

      <div
        ref={drawer.canvasRef}
        onPointerDown={drawer.onCanvasPointerDown}
        className={cn("mobile-canvas absolute inset-0 z-10 overflow-hidden bg-background", drawer.open && "pushed")}
      >
        {/* `display:contents` — exists only to carry `inert`, without
         * affecting MobileTopBar's absolute positioning underneath. With
         * the drawer open, the whole main screen (bar + chat) is truly out
         * of reach — no scroll, no focus, no click — until a tap on the
         * blocker below returns focus (equivalent to dragging back to the
         * left). */}
        <div inert={drawer.open} className="contents">
          <MobileTopBar
            title={title}
            connected={connected}
            onOpenDrawer={drawer.toggleDrawer}
            onNewConversation={onNewConversation}
          />

          {/* No padding-top here on purpose: the message log needs to be
           * able to scroll underneath MobileTopBar's blur zone (stays
           * visible-but-blurred) — the breathing room so content
           * doesn't end up stuck under the buttons comes from inside
           * MessageLog (ChatPanel passes `pt-[...]` only to the log), not
           * by pushing the whole column down. `relative` is the fix for
           * WebKit's backdrop-filter bug (see comment in MessageLog.tsx) —
           * do not remove. */}
          <div className="relative flex h-full flex-col">{children}</div>
        </div>

        <div
          onPointerDown={drawer.onBlockerPointerDown}
          onClick={drawer.closeDrawer}
          className={cn("absolute inset-0 z-[39]", drawer.open ? "pointer-events-auto cursor-pointer" : "pointer-events-none")}
        />
      </div>
    </div>
  );
}
