import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useLayoutCommands } from "@/hooks/useLayoutCommands";
import type { useResizableSidebar } from "@/hooks/tabs/useResizableSidebar";
import type { useSessionDock } from "@/hooks/tabs/useSessionDock";
import type { useTabs } from "@/hooks/tabs/useTabs";
import type { useTerminalTabs } from "@/hooks/tabs/useTerminalTabs";
import type { useFileTabs } from "@/hooks/tabs/useFileTabs";

function makeTabsState(overrides: Partial<ReturnType<typeof useTabs>> = {}): ReturnType<typeof useTabs> {
  return {
    tabs: [],
    groups: [{ id: "g1", tabIds: ["t1", "t2", "t3"], activeTabId: "t2", size: 1 }],
    focusedGroupId: "g1",
    activeTabId: "t2",
    visibleTabIds: new Set(),
    closeTab: vi.fn(),
    setActiveTab: vi.fn(),
    splitTabToNewGroup: vi.fn(),
    focusGroup: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useTabs>;
}

function makeDock(overrides: Record<string, unknown> = {}): ReturnType<typeof useSessionDock> {
  return { togglePane: vi.fn(), openPane: vi.fn(), isGroupHidden: vi.fn(() => false), setGroupHidden: vi.fn(), ...overrides } as unknown as ReturnType<typeof useSessionDock>;
}

function makeArgs(overrides: Record<string, unknown> = {}) {
  return {
    isCompact: false,
    activeTabId: "t2",
    tabsState: makeTabsState(),
    sessionDock: makeDock(),
    terminalTabs: { addTerminal: vi.fn() } as unknown as ReturnType<typeof useTerminalTabs>,
    fileTabs: { expandDirs: vi.fn(), openPreview: vi.fn() } as unknown as ReturnType<typeof useFileTabs>,
    resizable: { toggleCollapsed: vi.fn() } as unknown as ReturnType<typeof useResizableSidebar>,
    setDrawerOpen: vi.fn(),
    ...overrides,
  };
}

describe("useLayoutCommands — handleCycleTab", () => {
  it("moves to the next tab in the focused group, wrapping past the end", () => {
    const tabsState = makeTabsState();
    const { result } = renderHook(() => useLayoutCommands(makeArgs({ tabsState }) as never));
    result.current.handleCycleTab(1);
    expect(tabsState.setActiveTab).toHaveBeenCalledWith("t3");
  });

  it("moves to the previous tab, wrapping to the last one from the first", () => {
    const tabsState = makeTabsState({
      groups: [{ id: "g1", tabIds: ["t1", "t2", "t3"], activeTabId: "t1", size: 1 }],
    });
    const { result } = renderHook(() => useLayoutCommands(makeArgs({ tabsState }) as never));
    result.current.handleCycleTab(-1);
    expect(tabsState.setActiveTab).toHaveBeenCalledWith("t3");
  });

  it("is a no-op with fewer than two tabs in the focused group", () => {
    const tabsState = makeTabsState({ groups: [{ id: "g1", tabIds: ["t1"], activeTabId: "t1", size: 1 }] });
    const { result } = renderHook(() => useLayoutCommands(makeArgs({ tabsState }) as never));
    result.current.handleCycleTab(1);
    expect(tabsState.setActiveTab).not.toHaveBeenCalled();
  });

  it("is a no-op when no group is focused", () => {
    const tabsState = makeTabsState({ focusedGroupId: "missing" });
    const { result } = renderHook(() => useLayoutCommands(makeArgs({ tabsState }) as never));
    result.current.handleCycleTab(1);
    expect(tabsState.setActiveTab).not.toHaveBeenCalled();
  });
});

describe("useLayoutCommands — handleFocusGroupByIndex", () => {
  it("focuses the group at that index", () => {
    const tabsState = makeTabsState({
      groups: [
        { id: "g1", tabIds: ["t1"], activeTabId: "t1", size: 1 },
        { id: "g2", tabIds: ["t2"], activeTabId: "t2", size: 1 },
      ],
    });
    const { result } = renderHook(() => useLayoutCommands(makeArgs({ tabsState }) as never));
    result.current.handleFocusGroupByIndex(1);
    expect(tabsState.focusGroup).toHaveBeenCalledWith("g2");
  });

  it("is a no-op past however many groups are actually open", () => {
    const tabsState = makeTabsState({ groups: [{ id: "g1", tabIds: ["t1"], activeTabId: "t1", size: 1 }] });
    const { result } = renderHook(() => useLayoutCommands(makeArgs({ tabsState }) as never));
    result.current.handleFocusGroupByIndex(2);
    expect(tabsState.focusGroup).not.toHaveBeenCalled();
  });
});

describe("useLayoutCommands — desktop-only gates", () => {
  it("handleToggleTerminalPanel does nothing on a compact viewport", () => {
    const sessionDock = { togglePane: vi.fn(), openPane: vi.fn() } as unknown as ReturnType<typeof useSessionDock>;
    const { result } = renderHook(() => useLayoutCommands(makeArgs({ isCompact: true, sessionDock }) as never));
    result.current.handleToggleTerminalPanel();
    expect(sessionDock.togglePane).not.toHaveBeenCalled();
  });

  it("handleToggleTerminalPanel does nothing with no active tab", () => {
    const sessionDock = { togglePane: vi.fn(), openPane: vi.fn() } as unknown as ReturnType<typeof useSessionDock>;
    const { result } = renderHook(() => useLayoutCommands(makeArgs({ activeTabId: null, sessionDock }) as never));
    result.current.handleToggleTerminalPanel();
    expect(sessionDock.togglePane).not.toHaveBeenCalled();
  });

  it("handleToggleTerminalPanel toggles the terminal pane for the active tab otherwise", () => {
    const sessionDock = makeDock();
    const { result } = renderHook(() => useLayoutCommands(makeArgs({ sessionDock }) as never));
    result.current.handleToggleTerminalPanel();
    expect(sessionDock.togglePane).toHaveBeenCalledWith("t2", "terminal");
    expect(sessionDock.setGroupHidden).not.toHaveBeenCalled();
  });

  // The side panel's toggle hides the panel and the buttons that open its
  // panes, so a shortcut is the one way to ask for a pane while it is hidden.
  // It means "show me this": a toggle would close a pane nobody can see.
  it("shows a hidden side panel with the pane open instead of toggling the pane", () => {
    const sessionDock = makeDock({ isGroupHidden: vi.fn(() => true) });
    const { result } = renderHook(() => useLayoutCommands(makeArgs({ sessionDock }) as never));
    result.current.handleToggleFilesPanel();
    expect(sessionDock.setGroupHidden).toHaveBeenCalledWith("g1", false);
    expect(sessionDock.openPane).toHaveBeenCalledWith("t2", "files");
    expect(sessionDock.togglePane).not.toHaveBeenCalled();
  });

  it("shows a hidden side panel when a folder is opened in the terminal", () => {
    const sessionDock = makeDock({ isGroupHidden: vi.fn(() => true) });
    const terminalTabs = { addTerminal: vi.fn() } as unknown as ReturnType<typeof useTerminalTabs>;
    const { result } = renderHook(() => useLayoutCommands(makeArgs({ sessionDock, terminalTabs }) as never));
    result.current.handleOpenTerminalAt("t2", "/work");
    expect(sessionDock.setGroupHidden).toHaveBeenCalledWith("g1", false);
    expect(sessionDock.openPane).toHaveBeenCalledWith("t2", "terminal");
    expect(terminalTabs.addTerminal).toHaveBeenCalledWith("t2", "/work");
  });

  it("handleSplitActiveTab splits the focused group's active tab into a new group", () => {
    const tabsState = makeTabsState();
    const { result } = renderHook(() => useLayoutCommands(makeArgs({ tabsState }) as never));
    result.current.handleSplitActiveTab();
    expect(tabsState.splitTabToNewGroup).toHaveBeenCalledWith("t2", "g1");
  });

  it("handleToggleSidebarShortcut opens the drawer on compact, collapses the sidebar otherwise", () => {
    const setDrawerOpen = vi.fn();
    const resizable = { toggleCollapsed: vi.fn() } as unknown as ReturnType<typeof useResizableSidebar>;
    const { result: compact } = renderHook(() => useLayoutCommands(makeArgs({ isCompact: true, setDrawerOpen, resizable }) as never));
    compact.current.handleToggleSidebarShortcut();
    expect(setDrawerOpen).toHaveBeenCalled();
    expect(resizable.toggleCollapsed).not.toHaveBeenCalled();

    const { result: desktop } = renderHook(() => useLayoutCommands(makeArgs({ isCompact: false, setDrawerOpen, resizable }) as never));
    desktop.current.handleToggleSidebarShortcut();
    expect(resizable.toggleCollapsed).toHaveBeenCalled();
  });
});

describe("useLayoutCommands — handleCloseActiveTab", () => {
  it("closes the active tab", () => {
    const tabsState = makeTabsState();
    const { result } = renderHook(() => useLayoutCommands(makeArgs({ tabsState }) as never));
    result.current.handleCloseActiveTab();
    expect(tabsState.closeTab).toHaveBeenCalledWith("t2");
  });

  it("does nothing with no active tab", () => {
    const tabsState = makeTabsState();
    const { result } = renderHook(() => useLayoutCommands(makeArgs({ tabsState, activeTabId: null }) as never));
    result.current.handleCloseActiveTab();
    expect(tabsState.closeTab).not.toHaveBeenCalled();
  });
});
