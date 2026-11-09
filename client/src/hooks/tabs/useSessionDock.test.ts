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
    expect(result.current.getDock("t1")).toEqual({ panes: [], width: 480, maximized: null });
  });

  it("togglePane opens a pane that isn't there yet", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.togglePane("t1", "terminal"));
    expect(result.current.getDock("t1").panes).toEqual(["terminal"]);
  });

  it("togglePane closing a pane that's already open falls back to the no-selection view", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.togglePane("t1", "terminal"));
    act(() => result.current.togglePane("t1", "terminal"));
    expect(result.current.getDock("t1").panes).toEqual(["none"]);
  });

  it("togglePane switches to another pane instead of stacking it", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.togglePane("t1", "terminal"));
    act(() => result.current.togglePane("t1", "files"));
    expect(result.current.getDock("t1").panes).toEqual(["files"]);
  });

  it("togglePane closing the maximized pane also clears maximized", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.togglePane("t1", "terminal"));
    act(() => result.current.toggleMaximized("t1", "terminal"));
    act(() => result.current.togglePane("t1", "terminal"));
    expect(result.current.getDock("t1").maximized).toBeNull();
  });

  it("switching from an expanded pane keeps the column expanded on the new one", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.togglePane("t1", "agent"));
    act(() => result.current.toggleMaximized("t1", "agent"));
    act(() => result.current.togglePane("t1", "about"));
    expect(result.current.getDock("t1")).toMatchObject({ panes: ["about"], maximized: "about" });
    act(() => result.current.openPane("t1", "files"));
    expect(result.current.getDock("t1")).toMatchObject({ panes: ["files"], maximized: "files" });
  });

  it("never carries the expansion onto the no-selection view, which has no restore button", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.togglePane("t1", "about"));
    act(() => result.current.toggleMaximized("t1", "about"));
    act(() => result.current.togglePane("t1", "none"));
    expect(result.current.getDock("t1")).toMatchObject({ panes: ["none"], maximized: null });
  });

  it("switching panes leaves a column that was not expanded as it was", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.togglePane("t1", "agent"));
    act(() => result.current.togglePane("t1", "about"));
    expect(result.current.getDock("t1").maximized).toBeNull();
  });

  it("openPane adds a pane without closing it if already open", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.openPane("t1", "files"));
    act(() => result.current.openPane("t1", "files"));
    expect(result.current.getDock("t1").panes).toEqual(["files"]);
  });

  it("closePane falls back to the no-selection view, and closing that empties the dock; no-op for a tab with no dock yet", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.closePane("never-opened", "terminal"));
    expect(result.current.getDock("never-opened").panes).toEqual([]);

    act(() => result.current.openPane("t1", "terminal"));
    act(() => result.current.closePane("t1", "terminal"));
    expect(result.current.getDock("t1").panes).toEqual(["none"]);

    act(() => result.current.closePane("t1", "none"));
    expect(result.current.getDock("t1").panes).toEqual([]);
  });
});

describe("useSessionDock — width", () => {
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
});

describe("useSessionDock — width when a pane joins", () => {
  it("widens a terminal-width dock when the files pane is added", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.togglePane("t1", "terminal"));
    act(() => result.current.setWidth("t1", 320));
    expect(result.current.getDock("t1").width).toBe(320);
    act(() => result.current.openPane("t1", "files"));
    expect(result.current.getDock("t1").width).toBe(MIN_WIDTH_WITH_FILES);
  });

  it("leaves a dock that is already wide enough alone", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.togglePane("t1", "terminal"));
    act(() => result.current.setWidth("t1", 700));
    act(() => result.current.togglePane("t1", "files"));
    expect(result.current.getDock("t1").width).toBe(700);
  });
});

describe("useSessionDock — one view at a time", () => {
  it("switches to the pane that is opened, whatever it was showing", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.togglePane("t1", "terminal"));
    act(() => result.current.togglePane("t1", "agent"));
    act(() => result.current.openPane("t1", "about"));
    expect(result.current.getDock("t1")).toMatchObject({ panes: ["about"], last: "about" });
  });

  it("gives a room pane its own minimum width", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.togglePane("t1", "agent"));
    act(() => result.current.setWidth("t1", 100));
    expect(result.current.getDock("t1").width).toBe(385);
  });

  it("drops unknown kinds, repeats and all but the last pane when loading what a build wrote", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        t1: { panes: ["terminal", "bogus", "terminal", "files", "agent"], width: 480, splitRatio: 0.5, maximized: "terminal", last: "bogus" },
      }),
    );
    const { result } = renderHook(() => useSessionDock());
    expect(result.current.getDock("t1")).toEqual({ panes: ["agent"], width: 480, maximized: null });
  });
});

describe("useSessionDock — maximized", () => {
  it("toggleMaximized is a no-op until the dock has been created", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.toggleMaximized("t1", "terminal"));
    expect(result.current.getDock("t1").maximized).toBeNull();
  });

  it("toggleMaximized sets and then clears the maximized pane, leaving panes untouched", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.openPane("t1", "files"));

    act(() => result.current.toggleMaximized("t1", "files"));
    expect(result.current.getDock("t1").maximized).toBe("files");

    act(() => result.current.toggleMaximized("t1", "files"));
    const dock = result.current.getDock("t1");
    expect(dock.maximized).toBeNull();
    expect(dock.panes).toEqual(["files"]);
  });
});

describe("useSessionDock — persistence", () => {
  it("removes the old single-slot storage key on mount", () => {
    localStorage.setItem(OLD_STORAGE_KEY, JSON.stringify({ open: true }));
    renderHook(() => useSessionDock());
    expect(localStorage.getItem(OLD_STORAGE_KEY)).toBeNull();
  });

  it("loads persisted dock state on mount", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ t1: { panes: ["terminal"], width: 500, maximized: null } }));
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
    expect(result.current.getDock("t1")).toEqual({ panes: [], width: 480, maximized: null });
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

describe("useSessionDock — the side panel is one switch for every session", () => {
  it("starts closed", () => {
    const { result } = renderHook(() => useSessionDock());
    expect(result.current.isPanelShown()).toBe(false);
  });

  it("closing draws a tab's dock closed but keeps what it had open", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.openPane("t1", "files"));
    act(() => result.current.togglePanel("t1"));

    expect(result.current.getVisibleDock("t1", "g1")).toMatchObject({ panes: [], maximized: null });
    // The stored dock is untouched: opening the panel again is the whole undo.
    expect(result.current.getDock("t1").panes).toEqual(["files"]);

    act(() => result.current.togglePanel("t1"));
    expect(result.current.getVisibleDock("t1", "g1").panes).toEqual(["files"]);
  });

  it("keeps the panel open on another session, on the no-selection view when it picked nothing", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.openPane("t1", "files"));

    expect(result.current.isPanelShown()).toBe(true);
    expect(result.current.getVisibleDock("t1", "g1").panes).toEqual(["files"]);
    expect(result.current.getVisibleDock("t2", "g2").panes).toEqual(["none"]);
    // Only drawn: nothing was stored for the tab that picked nothing.
    expect(result.current.getDock("t2").panes).toEqual([]);
  });

  it("draws the fallback a room asks for on a tab that picked nothing", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.openPane("t1", "files"));
    expect(result.current.getVisibleDock("t2", "g1", "agent").panes).toEqual(["agent"]);
  });

  it("closing on one session closes it on the others", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.openPane("t1", "files"));
    act(() => result.current.openPane("t2", "terminal"));
    act(() => result.current.togglePanel("t2"));

    expect(result.current.getVisibleDock("t1", "g1").panes).toEqual([]);
    expect(result.current.getVisibleDock("t2", "g2").panes).toEqual([]);
  });

  it("never hides without a group (compact and iOS have no side panel to hide)", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.openPane("t1", "terminal"));
    act(() => result.current.togglePanel("t1"));
    expect(result.current.getVisibleDock("t1", null).panes).toEqual(["terminal"]);
  });

  it("returns the same dock until something changes, so a memoized panel is not re-rendered", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.openPane("t1", "terminal"));
    expect(result.current.getVisibleDock("t2", "g1")).toBe(result.current.getVisibleDock("t2", "g1"));
    act(() => result.current.togglePanel("t1"));
    expect(result.current.getVisibleDock("t1", "g1")).toBe(result.current.getVisibleDock("t1", "g1"));
  });

  it("remembers the choice across a restart", () => {
    const first = renderHook(() => useSessionDock());
    act(() => first.result.current.openPane("t1", "files"));
    first.unmount();
    const second = renderHook(() => useSessionDock());
    expect(second.result.current.isPanelShown()).toBe(true);
  });

  it("drops the per-group flag an older build wrote", () => {
    localStorage.setItem("anywh:right-panel-hidden", JSON.stringify({ g1: true }));
    renderHook(() => useSessionDock());
    expect(localStorage.getItem("anywh:right-panel-hidden")).toBeNull();
  });

  it("opens the panel with the pane when one is asked for while it is closed", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.openPane("t1", "files"));
    act(() => result.current.togglePanel("t1"));
    // A shortcut means "show me this": it must not close a pane nobody can see.
    act(() => result.current.togglePane("t1", "files"));
    expect(result.current.isPanelShown()).toBe(true);
    expect(result.current.getVisibleDock("t1", "g1").panes).toEqual(["files"]);

    act(() => result.current.togglePanel("t1"));
    act(() => result.current.openPane("t1", "files"));
    expect(result.current.isPanelShown()).toBe(true);
  });

  it("closing the no-selection view closes the panel", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.togglePanel("t1"));
    act(() => result.current.closePane("t1", "none"));
    expect(result.current.isPanelShown()).toBe(false);
  });
});

describe("useSessionDock — the side panel toggle", () => {
  it("opens the no-selection view on a tab that never had a pane", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.togglePanel("t1"));
    expect(result.current.getVisibleDock("t1", "g1").panes).toEqual(["none"]);
    expect(result.current.isPanelShown()).toBe(true);
  });

  it("restores a persisted Files choice instead of the no-selection view", () => {
    const first = renderHook(() => useSessionDock());
    act(() => first.result.current.openPane("t1", "files"));
    act(() => first.result.current.closePane("t1", "files"));
    act(() => first.result.current.closePane("t1", "none"));
    first.unmount();
    const { result } = renderHook(() => useSessionDock());
    expect(result.current.getDock("t1").panes).toEqual([]);
    act(() => result.current.togglePanel("t1"));
    expect(result.current.getVisibleDock("t1", "g1").panes).toEqual(["files"]);
  });

  it("leaves the no-selection view for a picked pane", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.togglePanel("t1"));
    act(() => result.current.togglePane("t1", "files"));
    expect(result.current.getDock("t1")).toMatchObject({ panes: ["files"], last: "files" });
  });

  it("opens the given fallback on a tab that never had a pane", () => {
    const { result } = renderHook(() => useSessionDock());
    act(() => result.current.togglePanel("t1", "agent"));
    expect(result.current.getDock("t1").panes).toEqual(["agent"]);
  });

  it("does nothing without an active tab but still flips the panel", () => {
    const { result } = renderHook(() => useSessionDock());
    expect(() => act(() => result.current.togglePanel(null))).not.toThrow();
    expect(result.current.isPanelShown()).toBe(true);
  });
});
