import { useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import type { useFileTabs } from "@/hooks/tabs/useFileTabs";
import type { useSessionDock } from "@/hooks/tabs/useSessionDock";
import type { useTabs } from "@/hooks/tabs/useTabs";
import type { useTerminalTabs } from "@/hooks/tabs/useTerminalTabs";
import type { TabPanelActions } from "@/components/shell/TabPanel";
import type { Dictionary } from "@/i18n";
import { removeCachedSession, touchCachedSession, upsertCachedSession } from "@/lib/format/sessionListCache";
import { notifyTurnComplete } from "@/lib/platform/notifications";
import type { Profile } from "@/lib/profiles/profiles";

interface UseTabPanelActionsArgs {
  dict: Dictionary;
  activeTabId: string | null;
  windowFocused: boolean;
  tabsState: ReturnType<typeof useTabs>;
  sessionDock: ReturnType<typeof useSessionDock>;
  terminalTabs: ReturnType<typeof useTerminalTabs>;
  fileTabs: ReturnType<typeof useFileTabs>;
  onOpenFilePath: (profile: Profile, tabId: string, path: string) => void;
  onOpenTerminalAt: (tabId: string, path: string) => void;
  setConnectedByTab: Dispatch<SetStateAction<Record<string, boolean>>>;
}

/** Everything a tab's panel calls back into `App` for, as one object built
 * once instead of a closure per tab per render. Each callback takes what it
 * acts on (the tab, the profile, the path) as an argument and closes over
 * nothing that changes between renders — that is what lets `TabPanel` be
 * `memo`'d, and it means `App` stops costing one render per open
 * conversation every time any of its state moves. See `TabPanelActions`'s
 * own comment.
 *
 * `activeTabId`/`windowFocused`/`onOpenFilePath`/`onOpenTerminalAt` are read
 * through refs, not captured directly: `onTurnComplete`/`onOpenPath`/
 * `onOpenTerminalAt` below run when a turn finishes or a path is opened from
 * chat text, arbitrarily long after the render that built this object, and
 * all four move on their own in the meantime. Capturing them would mean
 * notifying (or staying silent, or resolving a stale handler) based on where
 * the user was, not where they are. */
export function useTabPanelActions({
  dict,
  activeTabId,
  windowFocused,
  tabsState,
  sessionDock,
  terminalTabs,
  fileTabs,
  onOpenFilePath,
  onOpenTerminalAt,
  setConnectedByTab,
}: UseTabPanelActionsArgs): TabPanelActions {
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const windowFocusedRef = useRef(windowFocused);
  windowFocusedRef.current = windowFocused;
  const onOpenFilePathRef = useRef(onOpenFilePath);
  onOpenFilePathRef.current = onOpenFilePath;
  const onOpenTerminalAtRef = useRef(onOpenTerminalAt);
  onOpenTerminalAtRef.current = onOpenTerminalAt;

  return useMemo<TabPanelActions>(
    () => ({
      onTurnActiveChange: (tabId, active) => tabsState.setRunning(tabId, active),
      onBackgroundJobsChange: (tabId, jobs) => tabsState.setHasBackgroundJob(tabId, jobs.length > 0),
      onTurnComplete: (tab, profile, { stopped, lastUserText, lastAssistantText }) => {
        // Read through refs, not captured: this runs when a turn finishes,
        // which is arbitrarily long after the render that built this
        // object, and both values move on their own in the meantime.
        // Capturing them would mean notifying (or staying silent) based on
        // where the user was, not where they are.
        const stillVisible = tab.id === activeTabIdRef.current && windowFocusedRef.current;
        if (stillVisible) return;
        tabsState.setUnread(tab.id, true);
        notifyTurnComplete(tab.id, profile, tab.title ?? dict.common.untitledSession, lastUserText, lastAssistantText, stopped);
      },
      onTitle: (tab, title) => {
        tabsState.setTabTitle(tab.id, title);
        // Ungated on the active profile, unlike before: with every profile
        // in one list, a conversation titled in a background tab has to
        // appear under its own profile whether or not that profile is the
        // one currently selected.
        upsertCachedSession(tab.profileId, tab.id, title, Date.now());
      },
      onActivity: (tab) => {
        touchCachedSession(tab.profileId, tab.id);
      },
      onDeleted: (tab) => {
        tabsState.closeTab(tab.id);
        sessionDock.removeSession(tab.id);
        terminalTabs.removeSession(tab.id);
        fileTabs.removeSession(tab.id);
        removeCachedSession(tab.profileId, tab.id);
      },
      onConnectedChange: (tabId, connected) => {
        setConnectedByTab((prev) => (prev[tabId] === connected ? prev : { ...prev, [tabId]: connected }));
      },
      onTogglePane: (tabId, kind) => sessionDock.togglePane(tabId, kind),
      onClosePane: (tabId, kind) => sessionDock.closePane(tabId, kind),
      onToggleMaximized: (tabId, kind) => sessionDock.toggleMaximized(tabId, kind),
      onOpenPath: (profile, tabId, path) => onOpenFilePathRef.current(profile, tabId, path),
      onOpenTerminalAt: (tabId, path) => onOpenTerminalAtRef.current(tabId, path),
      onDockWidthChange: (tabId, width) => sessionDock.setWidth(tabId, width),
      onDockSplitRatioChange: (tabId, ratio) => sessionDock.setSplitRatio(tabId, ratio),
      onDockDragEnd: () => sessionDock.commitDock(),
    }),
    [
      dict,
      tabsState.setRunning,
      tabsState.setHasBackgroundJob,
      tabsState.setUnread,
      tabsState.setTabTitle,
      tabsState.closeTab,
      sessionDock.removeSession,
      sessionDock.togglePane,
      sessionDock.closePane,
      sessionDock.toggleMaximized,
      sessionDock.setWidth,
      sessionDock.setSplitRatio,
      sessionDock.commitDock,
      terminalTabs.removeSession,
      fileTabs.removeSession,
      setConnectedByTab,
    ],
  );
}

