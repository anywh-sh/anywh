import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RoomDock } from "@/components/sala/roomDock";
import type { DockPaneKind } from "@/hooks/tabs/useSessionDock";
import { useRoomPanes } from "@/hooks/sala/useRoomPanes";

function fakeDock(panes: DockPaneKind[]): RoomDock {
  return { panes, maximized: null, open: vi.fn(), toggle: vi.fn(), close: vi.fn(), toggleMaximized: vi.fn(), render: () => null };
}

describe("useRoomPanes — with a dock", () => {
  it("reads what is open from the dock, ignoring the panes that are not the room's", () => {
    const { result } = renderHook(() => useRoomPanes(fakeDock(["terminal", "about"])));
    expect(result.current).toMatchObject({ agentOpen: false, aboutOpen: true, last: "about" });
  });

  it("takes the pane opened last to be the one at the end of the stack", () => {
    const { result } = renderHook(() => useRoomPanes(fakeDock(["agent", "about"])));
    expect(result.current.last).toBe("about");
  });

  it("has no last pane when only the others are open", () => {
    const { result } = renderHook(() => useRoomPanes(fakeDock(["files", "terminal"])));
    expect(result.current.last).toBeNull();
  });

  it("asks the dock to open, toggle and close, and closeAll closes both of the room's panes", () => {
    const dock = fakeDock([]);
    const { result } = renderHook(() => useRoomPanes(dock));
    act(() => {
      result.current.open("agent");
      result.current.toggle("about");
      result.current.close("agent");
      result.current.closeAll();
    });
    expect(dock.open).toHaveBeenCalledWith("agent");
    expect(dock.toggle).toHaveBeenCalledWith("about");
    expect(dock.close).toHaveBeenCalledWith("agent");
    expect(dock.close).toHaveBeenCalledWith("about");
  });

  it("keeps its callbacks across renders, however the dock object is rebuilt", () => {
    const { result, rerender } = renderHook(({ dock }) => useRoomPanes(dock), { initialProps: { dock: fakeDock([]) } });
    const first = result.current;
    rerender({ dock: fakeDock(["agent"]) });
    expect(result.current.open).toBe(first.open);
    expect(result.current.close).toBe(first.close);
  });
});

describe("useRoomPanes — without a dock", () => {
  it("holds one panel at a time: opening a pane replaces the one that was open", () => {
    const { result } = renderHook(() => useRoomPanes(null));
    act(() => result.current.open("about"));
    expect(result.current).toMatchObject({ aboutOpen: true, agentOpen: false, last: "about" });
    act(() => result.current.open("agent"));
    expect(result.current).toMatchObject({ aboutOpen: false, agentOpen: true, last: "agent" });
  });

  it("toggles a pane shut, and closes only the pane that is open", () => {
    const { result } = renderHook(() => useRoomPanes(null));
    act(() => result.current.toggle("about"));
    act(() => result.current.close("agent"));
    expect(result.current.aboutOpen).toBe(true);
    act(() => result.current.toggle("about"));
    expect(result.current.last).toBeNull();
  });
});
