import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionActions } from "@/hooks/useSessionActions";
import type { useFileTabs } from "@/hooks/tabs/useFileTabs";
import type { useSessionDock } from "@/hooks/tabs/useSessionDock";
import type { useTabs } from "@/hooks/tabs/useTabs";
import type { useTerminalTabs } from "@/hooks/tabs/useTerminalTabs";
import { getDictionary } from "@/i18n";
import type { Profile } from "@/lib/profiles/profiles";

const activeProfile: Profile = {
  id: "profile-a",
  label: "A",
  host: "localhost",
  relayPort: 1,
};

function makeTabsState(): ReturnType<typeof useTabs> {
  return {
    openTab: vi.fn(),
    focusGroup: vi.fn(),
    setTabTitle: vi.fn(),
    closeTab: vi.fn(),
  } as unknown as ReturnType<typeof useTabs>;
}

function makeArgs(overrides: Record<string, unknown> = {}) {
  return {
    activeProfile,
    selectedProfileIds: new Set(["profile-a"]),
    setActiveProfileId: vi.fn(),
    setDrawerOpen: vi.fn(),
    dict: getDictionary("en"),
    tabsState: makeTabsState(),
    sessionDock: { removeSession: vi.fn() } as unknown as ReturnType<typeof useSessionDock>,
    terminalTabs: { removeSession: vi.fn() } as unknown as ReturnType<typeof useTerminalTabs>,
    fileTabs: { removeSession: vi.fn() } as unknown as ReturnType<typeof useFileTabs>,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("useSessionActions — handleNewConversation", () => {
  it("opens the new tab in the one selected profile when exactly one is selected", () => {
    const tabsState = makeTabsState();
    const { result } = renderHook(() =>
      useSessionActions(makeArgs({ tabsState, selectedProfileIds: new Set(["profile-b"]) }) as never),
    );
    result.current.handleNewConversation();
    expect(tabsState.openTab).toHaveBeenCalledWith("profile-b", expect.any(String), null, true);
  });

  it("falls back to the active profile when several profiles are selected", () => {
    const tabsState = makeTabsState();
    const { result } = renderHook(() =>
      useSessionActions(makeArgs({ tabsState, selectedProfileIds: new Set(["profile-a", "profile-b"]) }) as never),
    );
    result.current.handleNewConversation();
    expect(tabsState.openTab).toHaveBeenCalledWith("profile-a", expect.any(String), null, true);
  });

  it("closes the drawer", () => {
    const setDrawerOpen = vi.fn();
    const { result } = renderHook(() => useSessionActions(makeArgs({ setDrawerOpen }) as never));
    result.current.handleNewConversation();
    expect(setDrawerOpen).toHaveBeenCalledWith(false);
  });
});

describe("useSessionActions — handleNewTabInGroup", () => {
  it("focuses the group before opening the new tab", () => {
    const tabsState = makeTabsState();
    const calls: string[] = [];
    (tabsState.focusGroup as ReturnType<typeof vi.fn>).mockImplementation(() => calls.push("focusGroup"));
    (tabsState.openTab as ReturnType<typeof vi.fn>).mockImplementation(() => calls.push("openTab"));
    const { result } = renderHook(() => useSessionActions(makeArgs({ tabsState }) as never));
    result.current.handleNewTabInGroup("g2");
    expect(tabsState.focusGroup).toHaveBeenCalledWith("g2");
    expect(calls).toEqual(["focusGroup", "openTab"]);
  });
});

describe("useSessionActions — focusSession family", () => {
  it("focusSession switches the active profile and opens the tab", () => {
    const setActiveProfileId = vi.fn();
    const tabsState = makeTabsState();
    const { result } = renderHook(() => useSessionActions(makeArgs({ tabsState, setActiveProfileId }) as never));
    result.current.focusSession("profile-b", "s1", "Title");
    expect(setActiveProfileId).toHaveBeenCalledWith("profile-b");
    expect(tabsState.openTab).toHaveBeenCalledWith("profile-b", "s1", "Title");
  });

  it("handleSelectSession delegates to focusSession and closes the drawer", () => {
    const setActiveProfileId = vi.fn();
    const setDrawerOpen = vi.fn();
    const tabsState = makeTabsState();
    const { result } = renderHook(() => useSessionActions(makeArgs({ tabsState, setActiveProfileId, setDrawerOpen }) as never));
    result.current.handleSelectSession({ profileId: "profile-b", id: "s1", title: "Title" } as never);
    expect(setActiveProfileId).toHaveBeenCalledWith("profile-b");
    expect(tabsState.openTab).toHaveBeenCalledWith("profile-b", "s1", "Title");
    expect(setDrawerOpen).toHaveBeenCalledWith(false);
  });

  it("handleSearchSelectSession delegates to focusSession without touching the drawer", () => {
    const setActiveProfileId = vi.fn();
    const setDrawerOpen = vi.fn();
    const { result } = renderHook(() => useSessionActions(makeArgs({ setActiveProfileId, setDrawerOpen }) as never));
    result.current.handleSearchSelectSession("profile-b", "s1", "Title");
    expect(setActiveProfileId).toHaveBeenCalledWith("profile-b");
    expect(setDrawerOpen).not.toHaveBeenCalled();
  });
});

describe("useSessionActions — CRUD against an unknown profile", () => {
  it("handleRenameSession is a no-op when the profile isn't in the local registry", () => {
    const tabsState = makeTabsState();
    const { result } = renderHook(() => useSessionActions(makeArgs({ tabsState }) as never));
    result.current.handleRenameSession("does-not-exist", "s1", "New title");
    expect(tabsState.setTabTitle).not.toHaveBeenCalled();
  });

  it("handleDeleteSession is a no-op when the profile isn't in the local registry", () => {
    const tabsState = makeTabsState();
    const { result } = renderHook(() => useSessionActions(makeArgs({ tabsState }) as never));
    result.current.handleDeleteSession("does-not-exist", "s1");
    expect(tabsState.closeTab).not.toHaveBeenCalled();
  });
});
