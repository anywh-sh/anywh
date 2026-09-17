import { act } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useFileTabs } from "@/hooks/tabs/useFileTabs";

const STORAGE_KEY = "anywh:file-tabs";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("useFileTabs — preview tabs", () => {
  it("starts empty for a tab that was never touched", () => {
    const { result } = renderHook(() => useFileTabs());
    expect(result.current.getTabs("t1")).toEqual({ open: [], activePath: null, expanded: [], treeWidth: 180, root: null });
  });

  it("openPreview creates a single unpinned tab and activates it", () => {
    const { result } = renderHook(() => useFileTabs());
    act(() => result.current.openPreview("t1", "/a.ts"));
    expect(result.current.getTabs("t1").open).toEqual([{ path: "/a.ts", pinned: false }]);
    expect(result.current.getTabs("t1").activePath).toBe("/a.ts");
  });

  it("a second openPreview replaces the one preview tab in place instead of adding another", () => {
    const { result } = renderHook(() => useFileTabs());
    act(() => result.current.openPreview("t1", "/a.ts"));
    act(() => result.current.openPreview("t1", "/b.ts"));
    expect(result.current.getTabs("t1").open).toEqual([{ path: "/b.ts", pinned: false }]);
  });

  it("openPreview on a path that's already pinned just activates it, without duplicating", () => {
    const { result } = renderHook(() => useFileTabs());
    act(() => result.current.openPinned("t1", "/a.ts"));
    act(() => result.current.openPreview("t1", "/other.ts"));
    act(() => result.current.openPreview("t1", "/a.ts"));
    expect(result.current.getTabs("t1").open).toEqual([
      { path: "/a.ts", pinned: true },
      { path: "/other.ts", pinned: false },
    ]);
    expect(result.current.getTabs("t1").activePath).toBe("/a.ts");
  });

  it("openPreview appends a new preview tab when there isn't one yet, alongside pinned ones", () => {
    const { result } = renderHook(() => useFileTabs());
    act(() => result.current.openPinned("t1", "/a.ts"));
    act(() => result.current.openPreview("t1", "/b.ts"));
    expect(result.current.getTabs("t1").open).toEqual([
      { path: "/a.ts", pinned: true },
      { path: "/b.ts", pinned: false },
    ]);
  });
});

describe("useFileTabs — pinned tabs", () => {
  it("openPinned creates a pinned tab", () => {
    const { result } = renderHook(() => useFileTabs());
    act(() => result.current.openPinned("t1", "/a.ts"));
    expect(result.current.getTabs("t1").open).toEqual([{ path: "/a.ts", pinned: true }]);
  });

  it("openPinned on an existing preview tab pins it in place, keeping its position", () => {
    const { result } = renderHook(() => useFileTabs());
    act(() => result.current.openPinned("t1", "/a.ts"));
    act(() => result.current.openPreview("t1", "/b.ts"));
    act(() => result.current.openPinned("t1", "/b.ts"));
    expect(result.current.getTabs("t1").open).toEqual([
      { path: "/a.ts", pinned: true },
      { path: "/b.ts", pinned: true },
    ]);
  });

  it("openPinned on an already-pinned tab is idempotent", () => {
    const { result } = renderHook(() => useFileTabs());
    act(() => result.current.openPinned("t1", "/a.ts"));
    act(() => result.current.openPinned("t1", "/a.ts"));
    expect(result.current.getTabs("t1").open).toEqual([{ path: "/a.ts", pinned: true }]);
  });
});

describe("useFileTabs — closing and activation", () => {
  it("closeTab falls back activePath to the last remaining tab", () => {
    const { result } = renderHook(() => useFileTabs());
    act(() => result.current.openPinned("t1", "/a.ts"));
    act(() => result.current.openPinned("t1", "/b.ts"));
    act(() => result.current.closeTab("t1", "/b.ts"));
    expect(result.current.getTabs("t1").open).toEqual([{ path: "/a.ts", pinned: true }]);
    expect(result.current.getTabs("t1").activePath).toBe("/a.ts");
  });

  it("closeTab leaves activePath null once the last tab is closed", () => {
    const { result } = renderHook(() => useFileTabs());
    act(() => result.current.openPinned("t1", "/a.ts"));
    act(() => result.current.closeTab("t1", "/a.ts"));
    expect(result.current.getTabs("t1")).toEqual({ open: [], activePath: null, expanded: [], treeWidth: 180, root: null });
  });

  it("closing a tab that isn't the active one leaves activePath untouched", () => {
    const { result } = renderHook(() => useFileTabs());
    act(() => result.current.openPinned("t1", "/a.ts"));
    act(() => result.current.openPinned("t1", "/b.ts"));
    act(() => result.current.setActiveFile("t1", "/a.ts"));
    act(() => result.current.closeTab("t1", "/b.ts"));
    expect(result.current.getTabs("t1").activePath).toBe("/a.ts");
  });

  it("closeTab and setActiveFile are no-ops for a tab with no entry yet", () => {
    const { result } = renderHook(() => useFileTabs());
    expect(() => act(() => result.current.closeTab("ghost", "/a.ts"))).not.toThrow();
    expect(() => act(() => result.current.setActiveFile("ghost", "/a.ts"))).not.toThrow();
    expect(result.current.getTabs("ghost").open).toEqual([]);
  });
});

describe("useFileTabs — renaming", () => {
  it("renamePath moves the tab and the active pointer to the new path", () => {
    const { result } = renderHook(() => useFileTabs());
    act(() => result.current.openPinned("t1", "/old.ts"));
    act(() => result.current.renamePath("t1", "/old.ts", "/new.ts"));
    expect(result.current.getTabs("t1").open).toEqual([{ path: "/new.ts", pinned: true }]);
    expect(result.current.getTabs("t1").activePath).toBe("/new.ts");
  });

  it("renamePath leaves activePath alone when it pointed elsewhere", () => {
    const { result } = renderHook(() => useFileTabs());
    act(() => result.current.openPinned("t1", "/old.ts"));
    act(() => result.current.openPinned("t1", "/other.ts"));
    act(() => result.current.renamePath("t1", "/old.ts", "/new.ts"));
    expect(result.current.getTabs("t1").activePath).toBe("/other.ts");
  });
});

describe("useFileTabs — expanded directories", () => {
  it("toggleExpanded adds then removes a directory", () => {
    const { result } = renderHook(() => useFileTabs());
    act(() => result.current.toggleExpanded("t1", "/dir"));
    expect(result.current.getTabs("t1").expanded).toEqual(["/dir"]);
    act(() => result.current.toggleExpanded("t1", "/dir"));
    expect(result.current.getTabs("t1").expanded).toEqual([]);
  });

  it("expandDirs adds additively and never collapses an already-open directory", () => {
    const { result } = renderHook(() => useFileTabs());
    act(() => result.current.toggleExpanded("t1", "/a"));
    act(() => result.current.expandDirs("t1", ["/a", "/b", "/c"]));
    expect(new Set(result.current.getTabs("t1").expanded)).toEqual(new Set(["/a", "/b", "/c"]));
  });

  it("expandDirs with nothing new is a no-op on the stored value", () => {
    const { result } = renderHook(() => useFileTabs());
    act(() => result.current.expandDirs("t1", ["/a"]));
    const before = result.current.getTabs("t1");
    act(() => result.current.expandDirs("t1", ["/a"]));
    expect(result.current.getTabs("t1")).toBe(before);
  });
});

describe("useFileTabs — tree width", () => {
  it("clamps to the documented [120, 400] range", () => {
    const { result } = renderHook(() => useFileTabs());
    act(() => result.current.setTreeWidth("t1", 10));
    expect(result.current.getTabs("t1").treeWidth).toBe(120);
    act(() => result.current.setTreeWidth("t1", 1000));
    expect(result.current.getTabs("t1").treeWidth).toBe(400);
  });
});

describe("useFileTabs — syncRoot", () => {
  it("the first call just records the root without touching anything else", () => {
    const { result } = renderHook(() => useFileTabs());
    act(() => result.current.openPinned("t1", "/a.ts"));
    act(() => result.current.syncRoot("t1", "/repo"));
    const tabs = result.current.getTabs("t1");
    expect(tabs.root).toBe("/repo");
    expect(tabs.open).toEqual([{ path: "/a.ts", pinned: true }]);
  });

  it("a matching root on a later call is a no-op", () => {
    const { result } = renderHook(() => useFileTabs());
    act(() => result.current.syncRoot("t1", "/repo"));
    act(() => result.current.openPinned("t1", "/a.ts"));
    act(() => result.current.syncRoot("t1", "/repo"));
    expect(result.current.getTabs("t1").open).toEqual([{ path: "/a.ts", pinned: true }]);
  });

  it("a changed root clears path-based state but keeps treeWidth", () => {
    const { result } = renderHook(() => useFileTabs());
    act(() => result.current.syncRoot("t1", "/repo-a"));
    act(() => result.current.openPinned("t1", "/a.ts"));
    act(() => result.current.toggleExpanded("t1", "/dir"));
    act(() => result.current.setTreeWidth("t1", 250));

    act(() => result.current.syncRoot("t1", "/repo-b"));

    const tabs = result.current.getTabs("t1");
    expect(tabs.open).toEqual([]);
    expect(tabs.expanded).toEqual([]);
    expect(tabs.activePath).toBeNull();
    expect(tabs.root).toBe("/repo-b");
    expect(tabs.treeWidth).toBe(250);
  });
});

describe("useFileTabs — persistence and removeSession", () => {
  it("persists state to storage on change", () => {
    const { result } = renderHook(() => useFileTabs());
    act(() => result.current.openPinned("t1", "/a.ts"));
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as Record<string, { open: unknown[] }>;
    expect(stored.t1.open).toEqual([{ path: "/a.ts", pinned: true }]);
  });

  it("loads persisted state on mount", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ t1: { open: [{ path: "/a.ts", pinned: true }], activePath: "/a.ts", expanded: [], treeWidth: 180, root: null } }),
    );
    const { result } = renderHook(() => useFileTabs());
    expect(result.current.getTabs("t1").open).toEqual([{ path: "/a.ts", pinned: true }]);
  });

  it("removeSession drops the tab's entry entirely", () => {
    const { result } = renderHook(() => useFileTabs());
    act(() => result.current.openPinned("t1", "/a.ts"));
    act(() => result.current.removeSession("t1"));
    expect(result.current.getTabs("t1")).toEqual({ open: [], activePath: null, expanded: [], treeWidth: 180, root: null });
  });
});
