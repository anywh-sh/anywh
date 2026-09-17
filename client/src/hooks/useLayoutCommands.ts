import type { Dispatch, SetStateAction } from "react";
import type { useFileTabs } from "@/hooks/tabs/useFileTabs";
import type { useResizableSidebar } from "@/hooks/tabs/useResizableSidebar";
import type { useSessionDock } from "@/hooks/tabs/useSessionDock";
import type { useTabs } from "@/hooks/tabs/useTabs";
import type { useTerminalTabs } from "@/hooks/tabs/useTerminalTabs";
import { resolveChatPath } from "@/lib/relay/filesClient";
import { isIOS } from "@/lib/platform/platform";
import type { Profile } from "@/lib/profiles/profiles";

interface UseLayoutCommandsArgs {
  isCompact: boolean;
  activeTabId: string | null;
  tabsState: ReturnType<typeof useTabs>;
  sessionDock: ReturnType<typeof useSessionDock>;
  terminalTabs: ReturnType<typeof useTerminalTabs>;
  fileTabs: ReturnType<typeof useFileTabs>;
  resizable: ReturnType<typeof useResizableSidebar>;
  setDrawerOpen: Dispatch<SetStateAction<boolean>>;
}

/** The nine commands that move panels, panes and tab focus around rather
 * than touching a session's content — the desktop-only gates on most of
 * these (terminal/files/split) share one reason: on compact/iOS there's only
 * ever one group and no room for a second column or a side dock. */
export function useLayoutCommands({
  isCompact,
  activeTabId,
  tabsState,
  sessionDock,
  terminalTabs,
  fileTabs,
  resizable,
  setDrawerOpen,
}: UseLayoutCommandsArgs): {
  handleCloseActiveTab: () => void;
  handleToggleSidebarShortcut: () => void;
  handleToggleTerminalPanel: () => void;
  handleToggleFilesPanel: () => void;
  handleOpenTerminalAt: (tabId: string, path: string) => void;
  handleOpenFilePath: (profile: Profile, tabId: string, rawPath: string) => void;
  handleCycleTab: (direction: 1 | -1) => void;
  handleSplitActiveTab: () => void;
  handleFocusGroupByIndex: (index: number) => void;
} {
  function handleCloseActiveTab(): void {
    if (!activeTabId) return;
    tabsState.closeTab(activeTabId);
  }

  function handleToggleSidebarShortcut(): void {
    if (isCompact) {
      setDrawerOpen((open) => !open);
    } else {
      resizable.toggleCollapsed();
    }
  }

  // Embedded terminal — desktop only (the original screenshot/flow
  // is clearly desktop, iOS is left out for now, same gate that voice/titlebar
  // already use).
  function handleToggleTerminalPanel(): void {
    if (isCompact || isIOS() || !activeTabId) return;
    sessionDock.togglePane(activeTabId, "terminal");
  }

  // Work dir file panel — same desktop-only gate as the terminal.
  function handleToggleFilesPanel(): void {
    if (isCompact || isIOS() || !activeTabId) return;
    sessionDock.togglePane(activeTabId, "files");
  }

  /** "Open in terminal" on a folder row in the file tree — always a fresh
   * tab (never reuses/clobbers one the user might already be typing in),
   * rooted at that folder. `openPane` (not `togglePane`) because this only
   * ever means "show me this", never "close it" — same desktop-only gate as
   * the terminal panel itself. */
  function handleOpenTerminalAt(tabId: string, path: string): void {
    if (isCompact || isIOS()) return;
    sessionDock.openPane(tabId, "terminal");
    terminalTabs.addTerminal(tabId, path);
  }

  /** A path mentioned in assistant chat text (`Message.tsx`'s `AssistantText`)
   * — same "always show it" gate/`openPane` as `handleOpenTerminalAt` above.
   * Resolution (bare-filename search, ancestor walk for a wrong last
   * segment) runs server-side (`relay/src/fsFiles.ts::resolveChatPath`) —
   * `existingDirs` gets expanded in the tree regardless of whether `target`
   * panned out, so a path that's slightly off still lands the user
   * somewhere browsable instead of just failing silently. */
  function handleOpenFilePath(profile: Profile, tabId: string, rawPath: string): void {
    if (isCompact || isIOS()) return;
    sessionDock.openPane(tabId, "files");
    resolveChatPath(profile, tabId, rawPath)
      .then(({ target, isDirectory, existingDirs }) => {
        if (existingDirs.length > 0) fileTabs.expandDirs(tabId, existingDirs);
        if (target && !isDirectory) fileTabs.openPreview(tabId, target);
      })
      .catch(() => {});
  }

  // Ctrl+Tab / Ctrl+Shift+Tab, like a browser. Cycles within the focused
  // group only — with more than one group open, cycling through every tab
  // in the app regardless of which group it's in would jump the view to a
  // different group out from under Ctrl+Tab, which isn't what "next tab"
  // means once tabs are split into columns.
  function handleCycleTab(direction: 1 | -1): void {
    const focusedGroup = tabsState.groups.find((group) => group.id === tabsState.focusedGroupId);
    if (!focusedGroup || focusedGroup.tabIds.length < 2) return;
    const currentIndex = focusedGroup.tabIds.indexOf(focusedGroup.activeTabId ?? "");
    if (currentIndex === -1) return;
    const nextIndex = (currentIndex + direction + focusedGroup.tabIds.length) % focusedGroup.tabIds.length;
    tabsState.setActiveTab(focusedGroup.tabIds[nextIndex]);
  }

  // `Ctrl+\` (VS Code's own "split editor") — moves the focused group's
  // active tab into a new group immediately to its right. Desktop only, same
  // gate as the dock: on compact/iOS there's only ever one group (narrow
  // viewports fall back to one flat strip), so splitting wouldn't have
  // anywhere to put a second column anyway.
  function handleSplitActiveTab(): void {
    if (isCompact || isIOS() || !activeTabId) return;
    tabsState.splitTabToNewGroup(activeTabId, tabsState.focusedGroupId);
  }

  // Ctrl+1/2/3 — focuses the Nth group left to right. No-op past however
  // many groups are actually open (never more than MAX_GROUPS anyway).
  function handleFocusGroupByIndex(index: number): void {
    const group = tabsState.groups[index];
    if (group) tabsState.focusGroup(group.id);
  }

  return {
    handleCloseActiveTab,
    handleToggleSidebarShortcut,
    handleToggleTerminalPanel,
    handleToggleFilesPanel,
    handleOpenTerminalAt,
    handleOpenFilePath,
    handleCycleTab,
    handleSplitActiveTab,
    handleFocusGroupByIndex,
  };
}
