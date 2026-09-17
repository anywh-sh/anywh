import { act } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIN_USABLE_CHAT_PX, MIN_WIDTH_WITH_FILES, useSessionDock } from "@/hooks/tabs/useSessionDock";

const STORAGE_KEY = "anywh:session-dock";
const OLD_STORAGE_KEY = "anywh:session-panels";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("useSessionDock — panes", () => {
  it("starts closed for a tab that was never touched", () => {
    const { result } = renderHook(() => useSessionDock());
    expect(result.current.getDock("t1")).toEqual({ panes: [], width: 480, splitRatio: 0.5, maximized: null });
  });

  it("togglePane opens a pane that isn't there yet", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.togglePane("t1", "terminal"));
    expect(result.current.getDock("t1").panes).toEqual(["terminal"]);
  });

  it("togglePane closes a pane that's already open", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.togglePane("t1", "terminal"));
    act(() => result.current.togglePane("t1", "terminal"));
    expect(result.current.getDock("t1").panes).toEqual([]);
  });

  it("togglePane stacks a second pane below the first, in call order", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.togglePane("t1", "terminal"));
    act(() => result.current.togglePane("t1", "files"));
    expect(result.current.getDock("t1").panes).toEqual(["terminal", "files"]);
  });

  it("togglePane closing the maximized pane also clears maximized", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.togglePane("t1", "terminal"));
    act(() => result.current.toggleMaximized("t1", "terminal"));
    act(() => result.current.togglePane("t1", "terminal"));
    expect(result.current.getDock("t1").maximized).toBeNull();
  });

  it("openPane adds a pane without closing it if already open", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.openPane("t1", "files"));
    act(() => result.current.openPane("t1", "files"));
    expect(result.current.getDock("t1").panes).toEqual(["files"]);
  });

  it("closePane removes a pane and is a no-op for a tab with no dock yet", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.closePane("never-opened", "terminal"));
    expect(result.current.getDock("never-opened").panes).toEqual([]);

    act(() => result.current.openPane("t1", "terminal"));
    act(() => result.current.closePane("t1", "terminal"));
    expect(result.current.getDock("t1").panes).toEqual([]);
  });
});

describe("useSessionDock — width and split ratio", () => {
  it("setWidth is a no-op until the dock has been created by a pane call", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.setWidth("t1", 600));
    expect(result.current.getDock("t1").width).toBe(480);
  });

  it("setWidth clamps to the terminal-only minimum", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.openPane("t1", "terminal"));
    act(() => result.current.setWidth("t1", 10));
    expect(result.current.getDock("t1").width).toBe(320);
  });

  it("setWidth clamps to the wider minimum once the files pane is present", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.openPane("t1", "files"));
    act(() => result.current.setWidth("t1", 10));
    expect(result.current.getDock("t1").width).toBe(MIN_WIDTH_WITH_FILES);
  });

  it("setWidth clamps to the maximum", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.openPane("t1", "terminal"));
    act(() => result.current.setWidth("t1", 5000));
    expect(result.current.getDock("t1").width).toBe(900);
  });

  it("setSplitRatio clamps to [0.2, 0.8]", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.openPane("t1", "terminal"));
    act(() => result.current.setSplitRatio("t1", -1));
    expect(result.current.getDock("t1").splitRatio).toBeCloseTo(0.2);
    act(() => result.current.setSplitRatio("t1", 5));
    expect(result.current.getDock("t1").splitRatio).toBeCloseTo(0.8);
  });
});

describe("useSessionDock — maximized", () => {
  it("toggleMaximized is a no-op until the dock has been created", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.toggleMaximized("t1", "terminal"));
    expect(result.current.getDock("t1").maximized).toBeNull();
  });

  it("toggleMaximized sets and then clears the maximized pane, leaving panes/splitRatio untouched", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.openPane("t1", "terminal"));
    act(() => result.current.openPane("t1", "files"));
    act(() => result.current.setSplitRatio("t1", 0.3));

    act(() => result.current.toggleMaximized("t1", "files"));
    expect(result.current.getDock("t1").maximized).toBe("files");

    act(() => result.current.toggleMaximized("t1", "files"));
    const dock = result.current.getDock("t1");
    expect(dock.maximized).toBeNull();
    expect(dock.panes).toEqual(["terminal", "files"]);
    expect(dock.splitRatio).toBeCloseTo(0.3);
  });
});

describe("useSessionDock — persistence", () => {
  it("removes the old single-slot storage key on mount", () => {
    localStorage.setItem(OLD_STORAGE_KEY, JSON.stringify({ open: true }));
    renderHook(() => useSessionDock());
    expect(localStorage.getItem(OLD_STORAGE_KEY)).toBeNull();
  });

  it("loads persisted dock state on mount", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ t1: { panes: ["terminal"], width: 500, splitRatio: 0.5, maximized: null } }));
    const { result } = renderHook(() => useSessionDock());
    expect(result.current.getDock("t1").panes).toEqual(["terminal"]);
    expect(result.current.getDock("t1").width).toBe(500);
  });

  it("persists a pane change immediately", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.togglePane("t1", "terminal"));
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as Record<string, { panes: string[] }>;
    expect(stored.t1.panes).toEqual(["terminal"]);
  });

  it("suppresses the persist effect for a drag-driven width/split update until commitDock flushes it", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.openPane("t1", "terminal"));
    const afterOpen = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as Record<string, { width: number }>;
    expect(afterOpen.t1.width).toBe(480);

    act(() => result.current.setWidth("t1", 700));
    // The in-memory state already moved...
    expect(result.current.getDock("t1").width).toBe(700);
    // ...but the drag-driven write was suppressed, so storage still lags.
    const midDrag = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as Record<string, { width: number }>;
    expect(midDrag.t1.width).toBe(480);

    act(() => result.current.commitDock());
    const afterCommit = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as Record<string, { width: number }>;
    expect(afterCommit.t1.width).toBe(700);
  });
});

describe("useSessionDock — removeSession", () => {
  it("drops the tab's entry entirely, reverting getDock to the empty default", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.openPane("t1", "terminal"));
    act(() => result.current.removeSession("t1"));
    expect(result.current.getDock("t1")).toEqual({ panes: [], width: 480, splitRatio: 0.5, maximized: null });
  });

  it("is a no-op for a tab with no entry", () => {
    const { result } = renderHook(() => useSessionDock());
    expect(() => act(() => result.current.removeSession("ghost"))).not.toThrow();
  });
});

// Sanity on the two exported constants other modules key layout math off of.
describe("useSessionDock — exported layout constants", () => {
  it("keeps the files minimum wider than the chat floor it feeds into useGroupSizeDrag", () => {
    expect(MIN_WIDTH_WITH_FILES).toBeLessThan(MIN_USABLE_CHAT_PX);
  });
});
