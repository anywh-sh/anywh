import type { Dispatch, SetStateAction } from "react";
import type { useFileTabs } from "@/hooks/tabs/useFileTabs";
import type { useSessionDock } from "@/hooks/tabs/useSessionDock";
import type { useTabs } from "@/hooks/tabs/useTabs";
import type { useTerminalTabs } from "@/hooks/tabs/useTerminalTabs";
import type { Dictionary } from "@/i18n";
import type { MergedSession } from "@/lib/format/sessionGrouping";
import { removeCachedSession, upsertCachedSession } from "@/lib/format/sessionListCache";
import { findProfile, type Profile } from "@/lib/profiles/profiles";
import { resolveConnection } from "@/lib/profiles/connectionResolver";
import { deleteSession, renameSession } from "@/lib/relay/relayClient";

interface UseSessionActionsArgs {
  activeProfile: Profile;
  selectedProfileIds: ReadonlySet<string>;
  setActiveProfileId: (id: string) => void;
  setDrawerOpen: Dispatch<SetStateAction<boolean>>;
  dict: Dictionary;
  tabsState: ReturnType<typeof useTabs>;
  sessionDock: ReturnType<typeof useSessionDock>;
  terminalTabs: ReturnType<typeof useTerminalTabs>;
  fileTabs: ReturnType<typeof useFileTabs>;
}

/** Every way a session/tab enters, moves between, or leaves view — creating
 * one, jumping to one (sidebar row, search, notification click), and the two
 * CRUD operations the relay's control API exposes (rename/delete). Grouped
 * together because they all share the same "which tab and which profile"
 * bookkeeping, not because they're used from the same place — `focusSession`
 * alone feeds both `SessionSearch` and `useNotificationClick`. */
export function useSessionActions({
  activeProfile,
  selectedProfileIds,
  setActiveProfileId,
  setDrawerOpen,
  dict,
  tabsState,
  sessionDock,
  terminalTabs,
  fileTabs,
}: UseSessionActionsArgs): {
  handleNewConversation: () => void;
  handleNewTabInGroup: (groupId: string) => void;
  handleSelectSession: (session: MergedSession) => void;
  focusSession: (profileId: string, sessionId: string, title?: string | null) => void;
  handleSearchSelectSession: (profileId: string, sessionId: string, title: string) => void;
  handleRenameSession: (profileId: string, id: string, title: string) => void;
  handleDeleteSession: (profileId: string, id: string) => void;
} {
  // Creates the session implicitly: opens a blank tab right away, without
  // asking for a name — the title is inferred from the first prompt the user
  // sends (the relay fires this in parallel with the turn, see
  // sessionManager.ts). The session only enters the sidebar once that title
  // arrives (ChatPanel's onTitle), not before.
  function handleNewConversation(): void {
    const id = crypto.randomUUID();
    // Filtered down to exactly one profile, that profile is unambiguously
    // the one being worked in, so a new conversation belongs there. With
    // several selected there is nothing to infer from, and it falls back to
    // the focused tab's profile as before.
    const [onlySelected] = selectedProfileIds;
    const target = selectedProfileIds.size === 1 ? onlySelected : activeProfile.id;
    tabsState.openTab(target, id, null, true);
    setDrawerOpen(false);
  }

  /** The `+` on a group's tab strip. `openTab` always appends to the focused
   * group, so clicking `+` on a strip that isn't focused would otherwise
   * open the tab in the other column. Focusing first works in one click
   * because both are functional updaters on the same `useTabs` state: React
   * batches them and `openTab`'s updater already sees the new
   * `focusedGroupId` — no second render needed in between. */
  function handleNewTabInGroup(groupId: string): void {
    tabsState.focusGroup(groupId);
    handleNewConversation();
  }

  /** A row in the sidebar can belong to any profile now, so this goes
   * through `focusSession` — the same path search and notification clicks
   * already used for "jump to a session that may not be in the current
   * profile". `openTab` records the profile on the tab but does not move
   * `activeProfile` on its own, and leaving that behind would keep the live
   * `/sessions/watch` socket, the tailnet-sidecar reference and the default
   * target for a new conversation pointing at the profile the user just
   * navigated away from. */
  function handleSelectSession(session: MergedSession): void {
    focusSession(session.profileId, session.id, session.title);
    setDrawerOpen(false);
  }

  /** Switches profile (sidebar) + opens/activates the tab — used both by
   * session search (Cmd/Ctrl+K) and by clicking a notification, the two
   * cases of "jump straight to a session that may not belong to the
   * currently selected profile". */
  function focusSession(profileId: string, sessionId: string, title: string | null = null): void {
    setActiveProfileId(profileId);
    tabsState.openTab(profileId, sessionId, title);
  }

  function handleSearchSelectSession(profileId: string, sessionId: string, title: string): void {
    focusSession(profileId, sessionId, title);
  }

  /** Explicit `profileId` (not always `activeProfile`) for the same reason as
   * `handleDeleteSession` right below: it's also called from a tab belonging
   * to a profile other than the one currently selected in the sidebar. */
  function handleRenameSession(profileId: string, id: string, title: string): void {
    const profile = findProfile(profileId);
    if (!profile) return;
    resolveConnection(profile)
      .then(({ host, port, token }) => renameSession(host, port, id, title, token))
      .then(() => {
        tabsState.setTabTitle(id, title);
        upsertCachedSession(profileId, id, title);
      })
      .catch((error: unknown) => {
        console.error("[anywh] failed to rename session", error);
        window.alert(dict.shell.sidebar.renameFailed);
      });
  }

  /** Only removes the session from anywh's control — doesn't delete the
   * transcript that Claude Code already keeps on its own. Explicit
   * `profileId` (not always `activeProfile`) because it's also called from a
   * tab belonging to a profile other than the one currently selected in the
   * sidebar. */
  function handleDeleteSession(profileId: string, id: string): void {
    const profile = findProfile(profileId);
    if (!profile) return;
    resolveConnection(profile)
      .then(({ host, port, token }) => deleteSession(host, port, id, token))
      .then(() => {
        tabsState.closeTab(id);
        sessionDock.removeSession(id);
        terminalTabs.removeSession(id);
        fileTabs.removeSession(id);
        removeCachedSession(profileId, id);
      })
      .catch((error: unknown) => {
        console.error("[anywh] failed to delete session", error);
        window.alert(dict.shell.sidebar.deleteFailed);
      });
  }

  return {
    handleNewConversation,
    handleNewTabInGroup,
    handleSelectSession,
    focusSession,
    handleSearchSelectSession,
    handleRenameSession,
    handleDeleteSession,
  };
}
